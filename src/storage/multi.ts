import type { AuditStorage, AuditEntry, AuditErrorHandler } from "../types.ts";

/**
 * Options for {@link multiStorage}.
 */
export interface MultiStorageOptions {
  /**
   * How to handle a failure from any individual adapter.
   *
   * - `"warn"` — Log a warning and continue (default).
   * - `"throw"` — Re-throw the first adapter error encountered.
   * - `"ignore"` — Silently swallow adapter errors.
   * - `(error, entries) => void` — Custom error handler.
   */
  onError?: AuditErrorHandler;
}

/**
 * An {@link AuditStorage} adapter that fans audit entries out to multiple
 * storage backends simultaneously. All adapters receive every entry; a failure
 * in one adapter does not prevent the others from receiving their entries.
 *
 * `flush` and `close` are forwarded to every adapter that implements them.
 *
 * @param adapters - One or more storage adapters to write to in parallel.
 * @param options - Optional error-handling configuration.
 * @returns An {@link AuditStorage} that writes to all provided adapters.
 *
 * @example
 * ```ts
 * import {
 *   withDrizzleAudit,
 *   multiStorage,
 *   drizzleTableStorage,
 *   consoleStorage,
 * } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: multiStorage(
 *     [drizzleTableStorage(auditLog, { db: rawDb }), consoleStorage()],
 *     { onError: "warn" },
 *   ),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Custom per-adapter error reporting
 * const db = withDrizzleAudit(rawDb, {
 *   storage: multiStorage(
 *     [primaryStorage, secondaryStorage],
 *     {
 *       onError: (error, entries) => {
 *         Sentry.captureException(error, { extra: { entries } });
 *       },
 *     },
 *   ),
 * });
 * ```
 */
export function multiStorage(
  adapters: AuditStorage[],
  options?: MultiStorageOptions,
): AuditStorage {
  return {
    async write(entries: AuditEntry[]) {
      const results = await Promise.allSettled(adapters.map((a) => a.write(entries)));

      for (const [i, result] of results.entries()) {
        if (result.status === "rejected") {
          const handler = options?.onError ?? "warn";
          if (handler === "throw") throw result.reason;
          if (handler === "ignore") continue;
          if (handler === "warn") {
            console.warn(`[drizzle-audit] multiStorage adapter ${i} failed:`, result.reason);
            continue;
          }
          handler(result.reason, entries);
        }
      }
    },

    async flush() {
      await Promise.allSettled(adapters.filter((a) => a.flush).map((a) => a.flush!()));
    },

    async close() {
      await Promise.allSettled(adapters.filter((a) => a.close).map((a) => a.close!()));
    },
  };
}
