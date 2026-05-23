import type { AuditStorage, AuditEntry } from "../types.ts";

/**
 * Options for {@link consoleStorage}.
 */
export interface ConsoleStorageOptions {
  /**
   * Custom logger to use instead of the global `console`.
   * Any object with a `log` method is accepted, making it easy to plug in
   * structured loggers such as `pino` or `winston`.
   *
   * @default console
   */
  logger?: Pick<Console, "log">;
}

/**
 * An {@link AuditStorage} adapter that prints audit entries to the console (or
 * a custom logger). Useful for development, debugging, and testing.
 *
 * Each entry is logged as a single line in the format:
 * `[AUDIT] <action> <tableName> #<rowId>` followed by a details object
 * containing `changes`, `oldData`, `newData`, `userId`, and `metadata`.
 *
 * @param options - Optional configuration.
 * @returns An {@link AuditStorage} that logs entries via `console.log` (or the
 *   provided logger).
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, consoleStorage } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: consoleStorage(),
 * });
 * // Prints: [AUDIT] INSERT users #1 { changes: { ... }, userId: null, ... }
 * ```
 *
 * @example
 * ```ts
 * // Using a custom structured logger
 * import pino from "pino";
 * const logger = pino();
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: consoleStorage({ logger }),
 * });
 * ```
 */
export function consoleStorage(options?: ConsoleStorageOptions): AuditStorage {
  const logger = options?.logger ?? console;

  return {
    async write(entries: AuditEntry[]) {
      for (const entry of entries) {
        const parts = [
          `[AUDIT]`,
          entry.action,
          entry.tableName ?? "",
          entry.rowId ? `#${entry.rowId}` : "",
        ].filter(Boolean);

        logger.log(parts.join(" "), {
          changes: entry.changes,
          oldData: entry.oldData,
          newData: entry.newData,
          userId: entry.userId,
          metadata: entry.metadata,
        });
      }
    },
  };
}
