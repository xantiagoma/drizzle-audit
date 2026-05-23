import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditStorage, AuditEntry } from "../types.ts";

const TX_KEY = Symbol.for("drizzle-audit:tx-db");
const g = globalThis as any;
if (!g[TX_KEY]) {
  g[TX_KEY] = new AsyncLocalStorage<any>();
}
const txStorage: AsyncLocalStorage<any> = g[TX_KEY];

/**
 * Options for {@link drizzleTableStorage}.
 */
export interface DrizzleTableStorageOptions {
  /**
   * The Drizzle database instance to write audit entries to.
   *
   * Required unless the storage is created inside a `withDrizzleAudit`-wrapped
   * database where a transaction-scoped db is injected automatically.
   */
  db?: any;
}

/**
 * An {@link AuditStorage} adapter that persists audit entries into a Drizzle
 * ORM table.
 *
 * When used inside a `withDrizzleAudit`-wrapped database, the adapter
 * automatically participates in the active Drizzle transaction so that audit
 * writes are atomic with the triggering operation. Outside of a transaction
 * context, `options.db` is used as the fallback connection.
 *
 * @param auditTable - The Drizzle table schema to insert audit rows into.
 * @param options - Optional configuration including the fallback `db` instance.
 * @returns An {@link AuditStorage} that writes entries to the given table.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { withDrizzleAudit, drizzleTableStorage } from "drizzle-audit";
 * import { auditLog } from "./schema";
 *
 * const rawDb = drizzle(pool);
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 * });
 *
 * // Audit entries are written inside the same transaction as the operation
 * await db.transaction(async (tx) => {
 *   await tx.insert(users).values({ name: "Alice" });
 *   // audit row is committed/rolled back together with the insert
 * });
 * ```
 */
export function drizzleTableStorage(
  auditTable: any,
  options?: DrizzleTableStorageOptions,
): AuditStorage {
  return {
    async write(entries: AuditEntry[]) {
      // Use transaction db if available, otherwise the configured db
      const targetDb = txStorage.getStore() ?? options?.db;
      if (!targetDb) {
        throw new Error(
          "[drizzle-audit] drizzleTableStorage requires a db instance. " +
            "Pass it via options.db or use the storage created by withDrizzleAudit.",
        );
      }

      if (entries.length === 0) return;

      await targetDb.insert(auditTable).values(
        entries.map((entry) => ({
          tableName: entry.tableName,
          action: entry.action,
          rowId: entry.rowId,
          changes: entry.changes,
          oldData: entry.oldData,
          newData: entry.newData,
          userId: entry.userId,
          metadata: entry.metadata,
          // Don't pass timestamp — let the column's default handle it.
          // PG/MySQL: defaultNow() generates a DB-level timestamp.
          // SQLite: $defaultFn(() => new Date().toISOString()) generates a string.
          // Passing entry.timestamp (a Date object) would fail on SQLite's bun:sqlite
          // driver which can't bind Date objects.
        })),
      );
    },
  };
}

/**
 * Run a function with a transaction-scoped db override for drizzleTableStorage.
 * This ensures audit writes inside a transaction use the same connection.
 * @internal
 */
export function _withTxDb<T>(txDb: any, fn: () => T): T {
  return txStorage.run(txDb, fn);
}
