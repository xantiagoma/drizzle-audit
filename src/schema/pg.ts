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

/**
 * Controls the type of primary key used for a PostgreSQL audit table.
 *
 * - `"uuid"` — A `uuid` column with `defaultRandom()`. Default.
 * - `"serial"` — A `bigserial` auto-incrementing integer column.
 *
 * @example
 * ```ts
 * const auditLog = pgAuditTable("audit_log", { idMode: "serial" });
 * ```
 */
export type AuditIdMode = "uuid" | "serial";

/**
 * Options for {@link pgAuditTable}.
 *
 * @example
 * ```ts
 * const auditLog = pgAuditTable("audit_log", {
 *   idMode: "uuid",
 *   extraColumns: () => ({
 *     tenantId: text("tenant_id").notNull(),
 *   }),
 * });
 * ```
 */
export interface PgAuditTableOptions {
  /**
   * The type of primary key to use for the audit table.
   * Defaults to `"uuid"`.
   */
  idMode?: AuditIdMode;
  /**
   * A factory function that returns additional Drizzle column definitions to
   * include in the audit table. Useful for adding tenant IDs, environment
   * tags, or any other application-specific columns.
   *
   * @example
   * ```ts
   * extraColumns: () => ({
   *   tenantId: text("tenant_id").notNull(),
   *   env: varchar("env", { length: 20 }),
   * })
   * ```
   */
  extraColumns?: () => Record<string, any>;
}

/**
 * Creates a Drizzle ORM table definition for storing audit log entries in
 * PostgreSQL.
 *
 * The table includes the standard audit columns (`id`, `table_name`, `action`,
 * `row_id`, `changes`, `old_data`, `new_data`, `user_id`, `metadata`,
 * `timestamp`) with appropriate indexes pre-configured. Pass `options` to
 * customise the primary key type or add extra columns.
 *
 * @param name - The SQL table name. Defaults to `"audit_log"`.
 * @param options - Optional configuration for id mode and extra columns.
 * @returns A Drizzle `pgTable` definition ready to use with migrations and
 *   `drizzleTableStorage`.
 *
 * @example
 * ```ts
 * // schema.ts — default UUID primary key
 * import { pgAuditTable } from "drizzle-audit/schema/pg";
 *
 * export const auditLog = pgAuditTable("audit_log");
 * ```
 *
 * @example
 * ```ts
 * // schema.ts — serial primary key with a custom tenant column
 * export const auditLog = pgAuditTable("audit_log", {
 *   idMode: "serial",
 *   extraColumns: () => ({
 *     tenantId: text("tenant_id").notNull(),
 *   }),
 * });
 * ```
 */
export function pgAuditTable(name = "audit_log", options?: PgAuditTableOptions) {
  const idMode = options?.idMode ?? "uuid";

  const idColumn =
    idMode === "serial"
      ? { id: bigserial("id", { mode: "number" }).primaryKey() }
      : { id: uuid("id").primaryKey().defaultRandom() };

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
    ],
  );
}
