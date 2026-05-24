import {
  pgTable,
  bigserial,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import type { IdMode } from "../id.ts";
import { getIdGenerator } from "../id.ts";

/**
 * Options for {@link pgAuditTable}.
 *
 * @example
 * ```ts
 * const auditLog = pgAuditTable("audit_log", {
 *   idMode: "uuidv7",
 *   extraColumns: () => ({
 *     tenantId: text("tenant_id").notNull(),
 *   }),
 * });
 * ```
 */
export interface PgAuditTableOptions {
  /**
   * How the primary key ID is generated.
   *
   * - `"uuidv7"` (default) — UUID v7 column with time-sortable `$defaultFn`.
   * - `"uuidv4"` — UUID column with PG-native `defaultRandom()`.
   * - `"serial"` — `bigserial` auto-incrementing integer.
   * - `{ generate: () => string }` — Custom generator (nanoid, ulid, typeid, etc.)
   *   stored in a `text` column.
   *
   * @example
   * ```ts
   * idMode: "uuidv7"  // default
   * idMode: "serial"
   * idMode: { generate: () => nanoid() }
   * ```
   */
  idMode?: IdMode;
  /**
   * A factory function that returns additional Drizzle column definitions.
   *
   * @example
   * ```ts
   * extraColumns: () => ({
   *   tenantId: text("tenant_id").notNull(),
   * })
   * ```
   */
  extraColumns?: () => Record<string, any>;
  /**
   * A function that returns additional Drizzle index definitions.
   * Receives the table reference so you can reference any column (including extra ones).
   *
   * @example
   * ```ts
   * import { index } from "drizzle-orm/pg-core"
   *
   * pgAuditTable("audit_log", {
   *   extraColumns: () => ({
   *     tenantId: text("tenant_id").notNull(),
   *   }),
   *   extraIndexes: (table) => [
   *     index("audit_tenant_action_idx").on(table.tenantId, table.action),
   *     index("audit_tenant_ts_idx").on(table.tenantId, table.timestamp),
   *   ],
   * })
   * ```
   */
  extraIndexes?: (table: any) => any[];
}

/**
 * Creates a Drizzle ORM table definition for storing audit log entries in
 * PostgreSQL.
 *
 * @param name - The SQL table name. Defaults to `"audit_log"`.
 * @param options - Optional configuration for id mode and extra columns.
 * @returns A Drizzle `pgTable` definition ready to use with migrations and
 *   `drizzleTableStorage`.
 *
 * @example
 * ```ts
 * export const auditLog = pgAuditTable();                              // UUID v7 default
 * export const auditLog = pgAuditTable("audit", { idMode: "serial" }); // bigserial
 * export const auditLog = pgAuditTable("audit", {                      // custom
 *   idMode: { generate: () => nanoid() },
 * });
 * ```
 */
export function pgAuditTable(name = "audit_log", options?: PgAuditTableOptions) {
  const mode = options?.idMode ?? "uuidv7";

  let idColumn: Record<string, any>;
  if (mode === "serial" || mode === "integer") {
    idColumn = { id: bigserial("id", { mode: "number" }).primaryKey() };
  } else if (mode === "uuidv4") {
    idColumn = { id: uuid("id").primaryKey().defaultRandom() };
  } else {
    // uuidv7 or custom — use text column with $defaultFn
    const generator = getIdGenerator(mode)!;
    idColumn = { id: text("id").primaryKey().$defaultFn(generator) };
  }

  return pgTable(
    name,
    {
      ...idColumn,
      tableName: text("table_name"),
      action: varchar("action", { length: 50 }).notNull(),
      rowId: text("row_id"),
      changes: jsonb("changes"),
      oldData: jsonb("old_data"),
      newData: jsonb("new_data"),
      userId: text("user_id"),
      metadata: jsonb("metadata"),
      timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
      ...options?.extraColumns?.(),
    },
    (table) => [
      index(`${name}_table_name_idx`).on(table.tableName),
      index(`${name}_row_id_idx`).on(table.rowId),
      index(`${name}_user_id_idx`).on(table.userId),
      index(`${name}_action_idx`).on(table.action),
      index(`${name}_timestamp_idx`).on(table.timestamp),
      ...(options?.extraIndexes?.(table) ?? []),
    ],
  );
}
