import { resolveContext, resolveTenantId } from "./context.ts";
import { generateAuditId } from "./id.ts";
import type { AuditEntry, AuditStorage, DrizzleAuditContext } from "./types.ts";
import {
  _defaultStorage,
  _defaultOnError,
  _defaultFallbackStorage,
} from "./audit-action-internal.ts";
import { handleWriteFailure } from "./write-failure.ts";

/**
 * Options for tracking the lifecycle of an action via {@link trackAction}.
 *
 * @example
 * ```ts
 * const options: TrackActionOptions = {
 *   action: "report.generate",
 *   tableName: "reports",
 *   rowId: "rpt_456",
 *   userId: "u_123",
 *   metadata: { format: "pdf" },
 * };
 * ```
 */
export interface TrackActionOptions {
  /** The name of the action being tracked (e.g. `"report.generate"`). */
  action: string;
  /** Optional table name associated with the action. */
  tableName?: string;
  /** Optional primary key of the row associated with the action. */
  rowId?: string;
  /**
   * The user performing the action. When provided, overrides the `userId`
   * value from the active audit context.
   */
  userId?: string;
  /**
   * The tenant the action belongs to. When provided (including `null`), overrides the
   * tenant resolved from the active audit context.
   */
  tenantId?: string | null;
  /** Additional metadata to include in both the start and end audit entries. */
  metadata?: Record<string, unknown>;
}

/**
 * A handle returned by {@link trackAction} that marks the end of a tracked
 * action when disposed.
 *
 * Implements both `Disposable` (synchronous, fire-and-forget) and
 * `AsyncDisposable` (awaitable) so it works with `using` / `await using`
 * statements.
 *
 * @example
 * ```ts
 * // Synchronous disposal with "using"
 * {
 *   using tracker = trackAction({ action: "import.run" });
 *   tracker.addMetadata({ rowCount: 100 });
 *   // Completion entry is written when the block exits
 * }
 * ```
 *
 * @example
 * ```ts
 * // Asynchronous disposal with "await using"
 * {
 *   await using tracker = trackAction({ action: "export.run" });
 *   tracker.addMetadata({ format: "csv" });
 *   // Awaits the storage write before continuing
 * }
 * ```
 */
export interface ActionTracker extends Disposable, AsyncDisposable {
  /**
   * Merges additional key-value pairs into the metadata recorded on the
   * completion audit entry. Can be called multiple times; data is accumulated.
   *
   * @param data - Key-value pairs to merge into the completion entry's metadata.
   *
   * @example
   * ```ts
   * tracker.addMetadata({ rowsProcessed: 250, warnings: 3 });
   * ```
   */
  addMetadata(data: Record<string, unknown>): void;
}

/**
 * Tracks the start and end of a long-running action by writing two audit
 * entries: one with `status: "started"` immediately, and one with
 * `status: "completed"` (plus elapsed `duration` in milliseconds) when the
 * returned tracker is disposed.
 *
 * Use the `using` or `await using` statement (ECMAScript Explicit Resource
 * Management) to ensure the completion entry is always written, even if an
 * exception is thrown.
 *
 * @param options - Describes the action to track.
 * @param storage - Optional storage backend. Defaults to the storage
 *   registered by {@link withDrizzleAudit}.
 * @returns An {@link ActionTracker} that writes the completion entry on disposal.
 *
 * @example
 * ```ts
 * // Await the completion write (recommended for accurate timing)
 * async function generateReport(userId: string) {
 *   await using tracker = trackAction({
 *     action: "report.generate",
 *     userId,
 *     metadata: { format: "pdf" },
 *   });
 *
 *   const rows = await fetchReportData();
 *   tracker.addMetadata({ rowCount: rows.length });
 *   return rows;
 * }
 * ```
 *
 * @example
 * ```ts
 * // Fire-and-forget with synchronous "using"
 * function syncTask() {
 *   using tracker = trackAction({ action: "cache.warm" });
 *   warmCache();
 *   tracker.addMetadata({ keys: 1024 });
 * }
 * ```
 */
export function trackAction(options: TrackActionOptions, storage?: AuditStorage): ActionTracker {
  const targetStorage = storage ?? _defaultStorage();
  const onError = _defaultOnError();
  const fallbackStorage = _defaultFallbackStorage();
  const handleTrackError = (error: unknown, entries: AuditEntry[]) =>
    handleWriteFailure(error, entries, onError, fallbackStorage, "Failed to write tracked action");
  const startTime = performance.now();
  let extraMetadata: Record<string, unknown> = {};

  const ctx = resolveContext(options.userId !== undefined ? { userId: options.userId } : undefined);

  const tenantFor = (
    context: DrizzleAuditContext,
    metadata: Record<string, unknown> | null,
  ): string | null =>
    options.tenantId !== undefined
      ? options.tenantId
      : resolveTenantId({ tenantId: context.tenantId, metadata });

  // Write START entry immediately (fire-and-forget)
  if (targetStorage) {
    const startEntry: AuditEntry = {
      id: generateAuditId(),
      tableName: options.tableName ?? null,
      action: options.action,
      rowId: options.rowId ?? null,
      changes: null,
      oldData: null,
      newData: null,
      timestamp: new Date(),
      userId: ctx.userId,
      metadata: {
        ...ctx.metadata,
        ...options.metadata,
        status: "started",
      },
    };
    startEntry.tenantId = tenantFor(ctx, startEntry.metadata);

    targetStorage.write([startEntry]).catch((error) => handleTrackError(error, [startEntry]));
  }

  function buildEndEntry(status: "completed" | "error", error?: unknown): AuditEntry {
    const duration = Math.round(performance.now() - startTime);
    const endCtx = resolveContext(
      options.userId !== undefined ? { userId: options.userId } : undefined,
    );

    const entry: AuditEntry = {
      id: generateAuditId(),
      tableName: options.tableName ?? null,
      action: options.action,
      rowId: options.rowId ?? null,
      changes: null,
      oldData: null,
      newData: null,
      timestamp: new Date(),
      userId: endCtx.userId,
      metadata: {
        ...endCtx.metadata,
        ...options.metadata,
        ...extraMetadata,
        status,
        duration,
        ...(error !== undefined ? { error: String(error) } : {}),
      },
    };
    entry.tenantId = tenantFor(endCtx, entry.metadata);
    return entry;
  }

  return {
    addMetadata(data: Record<string, unknown>) {
      Object.assign(extraMetadata, data);
    },

    [Symbol.dispose]() {
      if (!targetStorage) return;
      const entry = buildEndEntry("completed");
      targetStorage.write([entry]).catch((err) => handleTrackError(err, [entry]));
    },

    async [Symbol.asyncDispose]() {
      if (!targetStorage) return;
      const entry = buildEndEntry("completed");
      try {
        await targetStorage.write([entry]);
      } catch (err) {
        await handleTrackError(err, [entry]);
      }
    },
  };
}
