import { mysqlTable, bigint, varchar, text, json, timestamp, index } from "drizzle-orm/mysql-core";
import type { IdMode } from "../id.ts";
import { getIdGenerator } from "../id.ts";

/**
 * Options for {@link mysqlAuditTable}.
 */
export interface MysqlAuditTableOptions {
  /**
   * How the primary key ID is generated.
   *
   * - `"uuidv7"` (default) — varchar(36) column with time-sortable UUID v7.
   * - `"uuidv4"` — varchar(36) column with random UUID v4.
   * - `"serial"` — bigint auto-increment column.
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
   * import { index } from "drizzle-orm/mysql-core"
   * extraIndexes: (table) => [index("custom_idx").on(table.userId, table.action)]
   * ```
   */
  extraIndexes?: (table: any) => any[];
}

/**
 * Creates a Drizzle ORM table definition for storing audit log entries in MySQL.
 *
 * @param name - The SQL table name. Defaults to `"audit_log"`.
 * @param options - Optional configuration for id mode and extra columns.
 */
export function mysqlAuditTable(name = "audit_log", options?: MysqlAuditTableOptions) {
  const mode = options?.idMode ?? "uuidv7";

  let idColumn: Record<string, any>;
  if (mode === "serial" || mode === "integer") {
    idColumn = { id: bigint("id", { mode: "number" }).primaryKey().autoincrement() };
  } else {
    const generator = getIdGenerator(mode)!;
    idColumn = {
      id: varchar("id", { length: 36 }).primaryKey().$defaultFn(generator),
    };
  }

  return mysqlTable(
    name,
    {
      ...idColumn,
      tableName: text("table_name"),
      action: varchar("action", { length: 50 }).notNull(),
      rowId: text("row_id"),
      changes: json("changes"),
      oldData: json("old_data"),
      newData: json("new_data"),
      userId: text("user_id"),
      metadata: json("metadata"),
      timestamp: timestamp("timestamp").notNull().defaultNow(),
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
