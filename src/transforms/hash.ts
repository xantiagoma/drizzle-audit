import type { AuditTransform } from "../types.ts";

/**
 * Returns an {@link AuditTransform} that replaces the values of the specified
 * fields with a deterministic hash in `changes`, `oldData`, and `newData`.
 *
 * The hash is computed using a fast, non-cryptographic FNV-1a algorithm and
 * is formatted as `"hash:<8 hex digits>"`. Because the same input always
 * produces the same output, hashed values can be compared for equality without
 * revealing the original data.
 *
 * > **Note:** For security-sensitive use cases (e.g. PII that must not be
 * > reversible) prefer a cryptographic hash. Provide a custom
 * > {@link AuditTransform} using `crypto.subtle.digest` or a similar API.
 *
 * For delta-format fields (`{ from, to }`), each non-null side is hashed
 * independently. Fields that are `null` or `undefined` are left untouched.
 *
 * @param fields - One or more field names to hash.
 * @returns An {@link AuditTransform} that hashes the given fields.
 *
 * @example
 * ```ts
 * import { withDrizzleAudit, drizzleTableStorage, hash } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   transform: hash("email", "ipAddress"),
 * });
 * // entry.changes.email === "hash:3d3e1f2a"
 * ```
 *
 * @example
 * ```ts
 * // Per-table hashing via TableAuditConfig
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   tables: {
 *     sessions: { transforms: [hash("token")] },
 *   },
 * });
 * ```
 */
export function hash(...fields: string[]): AuditTransform {
  const fieldSet = new Set(fields);
  return (entry) => ({
    ...entry,
    changes: hashFields(entry.changes, fieldSet),
    oldData: hashFields(entry.oldData, fieldSet),
    newData: hashFields(entry.newData, fieldSet),
  });
}

function hashFields(
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
          // For delta format, we use sync hash (simpler for transforms)
          result[field] = {
            from: (value as any).from != null ? syncHash(String((value as any).from)) : null,
            to: (value as any).to != null ? syncHash(String((value as any).to)) : null,
          };
        } else {
          result[field] = syncHash(String(value));
        }
      }
    }
  }
  return result;
}

function syncHash(input: string): string {
  // Simple non-cryptographic hash for sync context
  // For production, users should use their own async transform with proper hashing
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "hash:" + (h >>> 0).toString(16).padStart(8, "0");
}
