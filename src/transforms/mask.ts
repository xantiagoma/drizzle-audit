import type { AuditTransform } from "../types.ts";

/**
 * Returns an {@link AuditTransform} that partially obscures the values of the
 * specified fields in `changes`, `oldData`, and `newData`, preserving enough
 * structure to be recognisable without exposing the full value.
 *
 * Masking rules:
 * - **Email addresses** (`value` contains `@`): `john@example.com` → `j***@e*****.com`
 * - **Short strings** (≤ 4 characters): replaced entirely with `"****"`
 * - **All other strings**: last 4 characters are kept, the rest replaced with
 *   `"****"` — e.g. `"4111111111111234"` → `"****1234"`
 *
 * For delta-format fields (`{ from, to }`), each non-null side is masked
 * independently. Fields that are `null` or `undefined` are left untouched.
 *
 * @param fields - One or more field names to mask.
 * @returns An {@link AuditTransform} that masks the given fields.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, drizzleTableStorage, mask } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   transform: mask("email", "creditCard"),
 * });
 * // entry.changes.email === "j***@e*****.com"
 * // entry.changes.creditCard === "****1234"
 * ```
 *
 * @example
 * ```ts
 * // Per-table masking via TableAuditConfig
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   tables: {
 *     users: { transforms: [mask("email", "phone")] },
 *   },
 * });
 * ```
 */
export function mask(...fields: string[]): AuditTransform {
  const fieldSet = new Set(fields);
  return (entry) => ({
    ...entry,
    changes: maskFields(entry.changes, fieldSet),
    oldData: maskFields(entry.oldData, fieldSet),
    newData: maskFields(entry.newData, fieldSet),
  });
}

function maskValue(value: unknown): string {
  const str = String(value);

  // Email: j***@e*****.com
  if (str.includes("@")) {
    const [local, domain] = str.split("@");
    if (local && domain) {
      const parts = domain.split(".");
      const maskedLocal = local[0] + "***";
      const maskedDomain =
        (parts[0]?.[0] ?? "") + "***" + (parts.length > 1 ? "." + parts[parts.length - 1] : "");
      return `${maskedLocal}@${maskedDomain}`;
    }
  }

  // Short strings: just mask entirely
  if (str.length <= 4) {
    return "****";
  }

  // Default: show last 4 chars
  return "****" + str.slice(-4);
}

function maskFields(
  data: Record<string, unknown> | null,
  fields: Set<string>,
): Record<string, unknown> | null {
  if (!data) return data;
  const result = { ...data };
  for (const field of fields) {
    if (field in result) {
      const value = result[field];
      if (value !== null && value !== undefined) {
        if (typeof value === "object" && value !== null && "from" in value && "to" in value) {
          result[field] = {
            from: (value as any).from != null ? maskValue((value as any).from) : null,
            to: (value as any).to != null ? maskValue((value as any).to) : null,
          };
        } else {
          result[field] = maskValue(value);
        }
      }
    }
  }
  return result;
}
