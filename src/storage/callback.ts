import type { AuditStorage, AuditEntry } from "../types.ts";

/**
 * An {@link AuditStorage} adapter that delegates to an arbitrary callback
 * function. Use this when you need full control over how audit entries are
 * persisted without implementing the full {@link AuditStorage} interface.
 *
 * @param fn - Async or sync function that receives a batch of audit entries.
 *   Throwing inside `fn` will propagate the error according to the
 *   `onError` policy configured on `withDrizzleAudit`.
 * @returns An {@link AuditStorage} backed by the provided callback.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, callbackStorage } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: callbackStorage(async (entries) => {
 *     await myCustomBackend.bulkInsert(entries);
 *   }),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Collecting entries in tests
 * const captured: AuditEntry[] = [];
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: callbackStorage((entries) => {
 *     captured.push(...entries);
 *   }),
 * });
 * ```
 */
export function callbackStorage(fn: (entries: AuditEntry[]) => Promise<void> | void): AuditStorage {
  return {
    async write(entries: AuditEntry[]) {
      await fn(entries);
    },
  };
}
