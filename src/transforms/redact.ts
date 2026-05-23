import type { AuditTransform } from "../types.ts";

const REDACTED = "[REDACTED]";

/**
 * Returns an {@link AuditTransform} that replaces the values of the specified
 * fields with the string `"[REDACTED]"` in `changes`, `oldData`, and `newData`.
 *
 * For delta-format fields (`{ from, to }`), each non-null side is replaced
 * independently. Fields that are `null` or `undefined` are left untouched.
 *
 * @param fields - One or more field names to redact.
 * @returns An {@link AuditTransform} that redacts the given fields.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, drizzleTableStorage, redact } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   transform: redact("password", "ssn"),
 * });
 * // entry.changes.password === "[REDACTED]"
 * ```
 *
 * @example
 * ```ts
 * // Per-table redaction via TableAuditConfig
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   tables: {
 *     users: { transforms: [redact("password", "token")] },
 *   },
 * });
 * ```
 */
export function redact(...fields: string[]): AuditTransform {
  const fieldSet = new Set(fields);
  return (entry) => ({
    ...entry,
    changes: redactFields(entry.changes, fieldSet),
    oldData: redactFields(entry.oldData, fieldSet),
    newData: redactFields(entry.newData, fieldSet),
  });
}

function redactFields(
  data: Record<string, unknown> | null,
  fields: Set<string>,
): Record<string, unknown> | null {
  if (!data) return data;
  const result = { ...data };
  for (const field of fields) {
    if (field in result) {
      const value = result[field];
      if (value !== null && value !== undefined) {
        // Handle delta format { from, to }
        if (typeof value === "object" && value !== null && "from" in value && "to" in value) {
          result[field] = {
            from: (value as any).from != null ? REDACTED : null,
            to: (value as any).to != null ? REDACTED : null,
          };
        } else {
          result[field] = REDACTED;
        }
      }
    }
  }
  return result;
}
