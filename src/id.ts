import { v7 as uuidv7, v4 as uuidv4 } from "uuid";

/**
 * Built-in ID generation presets.
 *
 * - `"uuidv7"` — Time-sortable UUID v7 (default). Best for audit logs.
 * - `"uuidv4"` — Random UUID v4.
 * - `"serial"` — No client-side generation; relies on DB auto-increment.
 */
export type IdPreset = "uuidv7" | "uuidv4" | "serial" | "integer";

/**
 * Configuration for audit entry ID generation.
 *
 * Can be a preset string or a custom generator function.
 *
 * @example
 * ```ts
 * // Presets
 * idMode: "uuidv7"  // default, time-sortable
 * idMode: "uuidv4"  // random UUID
 * idMode: "serial"  // DB auto-increment (bigserial/integer)
 *
 * // Custom generators
 * import { nanoid } from "nanoid"
 * idMode: { generate: () => nanoid() }
 *
 * import { ulid } from "ulid"
 * idMode: { generate: () => ulid() }
 *
 * import { typeid } from "typeid-js"
 * idMode: { generate: () => typeid("audit").toString() }
 * ```
 */
export type IdMode = IdPreset | { generate: () => string };

/**
 * Get the ID generator function for the given mode.
 * @internal
 */
export function getIdGenerator(mode: IdMode = "uuidv7"): (() => string) | null {
  if (typeof mode === "object") return mode.generate;
  if (mode === "uuidv7") return uuidv7;
  if (mode === "uuidv4") return uuidv4;
  if (mode === "serial" || mode === "integer") return null;
  return uuidv7;
}

// Default generator used by wrap-builders, audit-action, track-action
let _idGenerator: (() => string) | null = uuidv7;

/**
 * Set the global ID generator. Called by `withDrizzleAudit`.
 * @internal
 */
export function _setIdGenerator(mode: IdMode | undefined): void {
  _idGenerator = getIdGenerator(mode ?? "uuidv7");
}

/**
 * Generate an audit entry ID using the configured generator.
 * @internal
 */
export function generateAuditId(): string {
  return (_idGenerator ?? uuidv7)();
}
