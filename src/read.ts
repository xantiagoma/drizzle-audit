import { resolveTenantId } from "./context.ts";
import type { AuditEntry } from "./types.ts";

/**
 * Normalize an audit row read back from a database into an {@link AuditEntry}.
 *
 * What a driver returns for an audit table differs: SQLite stores `timestamp` as an ISO
 * string, raw SQL (`db.execute`, `db.all`, …) returns `snake_case` keys and, depending on
 * the driver, timestamps as strings and JSON columns as unparsed text, and serial ids come
 * back as numbers. This turns any of those shapes into an entry that matches the type:
 *
 * - `timestamp` → `Date`, from a `Date`, an ISO string, a SQL `YYYY-MM-DD HH:MM:SS[.fff]`
 *   string (no zone means UTC — what `CURRENT_TIMESTAMP` and UTC MySQL sessions return),
 *   a `±HH` / `±HHMM` offset (Postgres text output), or epoch seconds / milliseconds.
 * - `changes` / `oldData` / `newData` / `metadata` → parsed when they arrive as JSON text.
 * - `id` → string; missing nullable fields → `null`.
 * - `tenantId` → the `tenantId` / `tenant_id` column, else a string or number
 *   `metadata.tenantId` (rows written before `tenantId` existed), else `null`.
 *
 * Both camelCase (`db.select().from(auditLog)`) and snake_case (raw SQL) keys are accepted.
 *
 * @param row - One row of an audit table (`pgAuditTable`, `sqliteAuditTable`,
 *   `mysqlAuditTable`, or any table with the same columns).
 * @returns The row as an {@link AuditEntry}, with a `Date` timestamp.
 * @throws TypeError if the timestamp is missing or cannot be parsed, or a JSON column holds
 *   invalid JSON.
 *
 * @example
 * ```ts
 * import { toAuditEntry } from "drizzle-audit";
 *
 * const rows = await db.select().from(auditLog); // SQLite: timestamp is a string
 * const entries = rows.map(toAuditEntry);         // timestamp is a Date everywhere
 * ```
 */
export function toAuditEntry(row: Record<string, unknown>): AuditEntry {
  const pick = (camel: string, snake: string): unknown => row[camel] ?? row[snake];
  const id = row.id;
  const metadata = parseJson(row.metadata, "metadata") ?? null;
  const tenantId = pick("tenantId", "tenant_id");

  return {
    id: id == null ? "" : String(id),
    tableName: stringOrNull(pick("tableName", "table_name")),
    action: String(row.action ?? ""),
    rowId: stringOrNull(pick("rowId", "row_id")),
    changes: parseJson(row.changes, "changes") ?? null,
    oldData: parseJson(pick("oldData", "old_data"), "oldData") ?? null,
    newData: parseJson(pick("newData", "new_data"), "newData") ?? null,
    timestamp: toDate(row.timestamp),
    userId: stringOrNull(pick("userId", "user_id")),
    tenantId: tenantId != null ? String(tenantId) : resolveTenantId({ metadata }),
    metadata,
  };
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function parseJson(value: unknown, field: string): Record<string, unknown> | null | undefined {
  if (typeof value !== "string") return value as Record<string, unknown> | null | undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`[drizzle-audit] toAuditEntry: ${field} is not valid JSON`);
  }
}

// `2026-11-20 21:40:50[.123][+00|+0000|+00:00|Z]` and the ISO `T` form.
const SQL_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Convert a driver's timestamp value to a `Date`.
 * @internal
 */
export function toDate(value: unknown): Date {
  let date: Date | undefined;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number" || typeof value === "bigint") {
    const n = Number(value);
    // Below 1e11 is a seconds value (1e11 ms is 1973; 1e11 s is year 5138).
    date = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
  } else if (typeof value === "string") {
    const match = SQL_TIMESTAMP.exec(value.trim());
    if (match) {
      const [, day, time, zone] = match;
      let offset = zone ? zone.toUpperCase() : "Z";
      if (offset !== "Z") {
        offset =
          offset.length === 3 ? `${offset}:00` : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
      }
      date = new Date(`${day}T${time}${offset}`);
    } else {
      date = new Date(value);
    }
  }
  if (!date || Number.isNaN(date.getTime())) {
    throw new TypeError(
      `[drizzle-audit] toAuditEntry: invalid timestamp ${JSON.stringify(String(value))}`,
    );
  }
  return date;
}
