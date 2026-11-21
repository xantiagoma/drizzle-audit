import { resolveContext, resolveTenantId } from "./context.ts";
import { generateAuditId } from "./id.ts";
import {
  _defaultStorage,
  _defaultOnError,
  _defaultFallbackStorage,
} from "./audit-action-internal.ts";
import { handleWriteFailure } from "./write-failure.ts";
import type { AuditEntry, AuditStorage } from "./types.ts";

/**
 * Options for recording a single custom audit action via {@link drizzleAuditAction}.
 *
 * Only `action` is required. All other fields are optional and will be set to
 * `null` when omitted. `userId` and `tenantId` override the values from the active
 * audit context; all other context metadata is merged automatically.
 *
 * @example
 * ```ts
 * const options: DrizzleAuditActionOptions = {
 *   action: "user.password_reset",
 *   tableName: "users",
 *   rowId: "u_123",
 *   userId: "admin_1",
 *   metadata: { reason: "support request" },
 * };
 * ```
 */
export interface DrizzleAuditActionOptions {
  /** The name of the action being performed (e.g. `"user.password_reset"`). */
  action: string;
  /** Optional table name associated with the action. */
  tableName?: string;
  /** Optional primary key of the row associated with the action. */
  rowId?: string;
  /** Arbitrary delta/changes payload to store alongside the entry. */
  changes?: Record<string, unknown>;
  /** Full row state before the action, if applicable. */
  oldData?: Record<string, unknown>;
  /** Full row state after the action, if applicable. */
  newData?: Record<string, unknown>;
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
  /** Additional metadata to merge into the entry alongside any context metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Records a single custom audit entry using the globally configured storage.
 *
 * Use this function to manually log business events (e.g. password resets,
 * exports, logins) that are not captured automatically by the Drizzle proxy.
 * The active audit context (set via `withDrizzleAuditContext`) is picked up
 * automatically; any `userId` or `metadata` supplied in `options` is merged
 * on top.
 *
 * If no storage is configured and none is passed explicitly, a warning is
 * emitted and the call is a no-op.
 *
 * @param options - Describes the action to record.
 * @param storage - Optional storage backend. Defaults to the storage
 *   registered by {@link withDrizzleAudit}.
 * @returns A promise that resolves when the entry has been written (or the
 *   error has been handled according to the configured `onError` policy).
 *
 * @example
 * ```ts
 * // Basic usage — relies on storage registered by withDrizzleAudit
 * await drizzleAuditAction({
 *   action: "user.export",
 *   tableName: "users",
 *   userId: "admin_1",
 *   metadata: { format: "csv", rowCount: 500 },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Passing explicit storage (useful in tests or scripts)
 * await drizzleAuditAction(
 *   { action: "cron.cleanup", metadata: { deletedRows: 42 } },
 *   myStorage,
 * );
 * ```
 */
export function drizzleAuditAction(
  options: DrizzleAuditActionOptions,
  storage?: AuditStorage,
): Promise<void> {
  const targetStorage = storage ?? _defaultStorage();
  if (!targetStorage) {
    console.warn(
      "[drizzle-audit] No storage configured for drizzleAuditAction. " +
        "Call withDrizzleAudit() first or pass storage explicitly.",
    );
    return Promise.resolve();
  }

  const ctx = resolveContext(options.userId !== undefined ? { userId: options.userId } : undefined);

  const metadata = options.metadata
    ? { ...ctx.metadata, ...options.metadata }
    : (ctx.metadata ?? null);

  const entry: AuditEntry = {
    id: generateAuditId(),
    tableName: options.tableName ?? null,
    action: options.action,
    rowId: options.rowId ?? null,
    changes: options.changes ?? null,
    oldData: options.oldData ?? null,
    newData: options.newData ?? null,
    timestamp: new Date(),
    userId: ctx.userId,
    tenantId:
      options.tenantId !== undefined
        ? options.tenantId
        : resolveTenantId({ tenantId: ctx.tenantId, metadata }),
    metadata,
  };

  const onError = _defaultOnError();

  return targetStorage
    .write([entry])
    .catch((error) =>
      handleWriteFailure(
        error,
        [entry],
        onError,
        _defaultFallbackStorage(),
        "Failed to write audit action",
      ),
    );
}
