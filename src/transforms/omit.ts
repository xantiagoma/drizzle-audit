import type { AuditTransform } from "../types.ts";

/**
 * Returns an {@link AuditTransform} that removes the specified fields entirely
 * from `changes`, `oldData`, and `newData`. Unlike {@link redact}, which
 * replaces values with `"[REDACTED]"`, `omit` deletes the keys so they do not
 * appear in the stored entry at all.
 *
 * @param fields - One or more field names to omit.
 * @returns An {@link AuditTransform} that omits the given fields.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, drizzleTableStorage, omit } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   transform: omit("internalNotes", "debugPayload"),
 * });
 * // entry.changes will not contain "internalNotes" or "debugPayload" keys
 * ```
 *
 * @example
 * ```ts
 * // Per-table omission via TableAuditConfig
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   tables: {
 *     orders: { transforms: [omit("rawWebhookPayload")] },
 *   },
 * });
 * ```
 */
export function omit(...fields: string[]): AuditTransform {
  const fieldSet = new Set(fields);
  return (entry) => ({
    ...entry,
    changes: omitFields(entry.changes, fieldSet),
    oldData: omitFields(entry.oldData, fieldSet),
    newData: omitFields(entry.newData, fieldSet),
  });
}

function omitFields(
  data: Record<string, unknown> | null,
  fields: Set<string>,
): Record<string, unknown> | null {
  if (!data) return data;
  const result = { ...data };
  for (const field of fields) {
    delete result[field];
  }
  return result;
}
