import { resolveContext } from "./context.ts";
import type { AuditEntry, AuditStorage, AuditErrorHandler } from "./types.ts";
import { _defaultStorage, _defaultOnError } from "./audit-action-internal.ts";

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
  const startTime = performance.now();
  let extraMetadata: Record<string, unknown> = {};

  const ctx = resolveContext(options.userId !== undefined ? { userId: options.userId } : undefined);

  // Write START entry immediately (fire-and-forget)
  if (targetStorage) {
    const startEntry: AuditEntry = {
      id: crypto.randomUUID(),
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

    targetStorage.write([startEntry]).catch((error) => {
      handleTrackError(onError, error, [startEntry]);
    });
  }

  function buildEndEntry(status: "completed" | "error", error?: unknown): AuditEntry {
    const duration = Math.round(performance.now() - startTime);
    const endCtx = resolveContext(
      options.userId !== undefined ? { userId: options.userId } : undefined,
    );

    return {
      id: crypto.randomUUID(),
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
  }

  return {
    addMetadata(data: Record<string, unknown>) {
      Object.assign(extraMetadata, data);
    },

    [Symbol.dispose]() {
      if (!targetStorage) return;
      const entry = buildEndEntry("completed");
      targetStorage.write([entry]).catch((err) => {
        handleTrackError(onError, err, [entry]);
      });
    },

    async [Symbol.asyncDispose]() {
      if (!targetStorage) return;
      const entry = buildEndEntry("completed");
      try {
        await targetStorage.write([entry]);
      } catch (err) {
        handleTrackError(onError, err, [entry]);
      }
    },
  };
}

function handleTrackError(
  onError: AuditErrorHandler | undefined,
  error: unknown,
  entries: AuditEntry[],
): void {
  const handler = onError ?? "warn";
  if (handler === "throw") throw error;
  if (handler === "ignore") return;
  if (handler === "warn") {
    console.warn("[drizzle-audit] Failed to write tracked action:", error);
    return;
  }
  handler(error, entries);
}
