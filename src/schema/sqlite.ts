import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import type { IdMode } from "../id.ts";
import { getIdGenerator } from "../id.ts";

/**
 * Options for {@link sqliteAuditTable}.
 */
export interface SqliteAuditTableOptions {
  /**
   * How the primary key ID is generated.
   *
   * - `"uuidv7"` (default) — Text column with time-sortable UUID v7.
   * - `"uuidv4"` — Text column with random UUID v4.
   * - `"serial"` — Integer auto-increment column.
   * - `{ generate: () => string }` — Custom generator stored in text column.
   */
  idMode?: IdMode;
  /** Extra columns to add to the audit table. */
  extraColumns?: () => Record<string, any>;
  /**
   * Extra indexes to add. Receives the table reference.
   *
   * @example
   * ```ts
   * import { index } from "drizzle-orm/sqlite-core"
   * extraIndexes: (table) => [index("custom_idx").on(table.userId, table.action)]
   * ```
   */
  extraIndexes?: (table: any) => any[];
}

/**
 * Creates a Drizzle ORM table definition for storing audit log entries in SQLite.
 *
 * @param name - The SQL table name. Defaults to `"audit_log"`.
 * @param options - Optional configuration for id mode and extra columns.
 */
export function sqliteAuditTable(name = "audit_log", options?: SqliteAuditTableOptions) {
  const mode = options?.idMode ?? "uuidv7";

  let idColumn: Record<string, any>;
  if (mode === "serial" || mode === "integer") {
    idColumn = { id: integer("id").primaryKey({ autoIncrement: true }) };
  } else {
    const generator = getIdGenerator(mode)!;
    idColumn = { id: text("id").primaryKey().$defaultFn(generator) };
  }

  return sqliteTable(
    name,
    {
      ...idColumn,
      tableName: text("table_name"),
      action: text("action").notNull(),
      rowId: text("row_id"),
      changes: text("changes", { mode: "json" }),
      oldData: text("old_data", { mode: "json" }),
      newData: text("new_data", { mode: "json" }),
      userId: text("user_id"),
      metadata: text("metadata", { mode: "json" }),
      timestamp: text("timestamp")
        .notNull()
        .$defaultFn(() => new Date().toISOString()),
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
