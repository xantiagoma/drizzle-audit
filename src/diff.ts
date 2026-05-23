/**
 * Represents a single field-level change between two objects.
 *
 * @example
 * ```ts
 * const diff: DiffEntry = { field: 'name', from: 'Alice', to: 'Bob' }
 * ```
 */
export interface DiffEntry {
  /** The field name that changed */
  field: string;
  /** The previous value (`undefined` if field was added) */
  from: unknown;
  /** The new value (`undefined` if field was removed) */
  to: unknown;
}

/**
 * Options for {@link computeDiff}.
 */
export interface ComputeDiffOptions {
  /** Fields to exclude from diff comparison */
  ignoreFields?: string[];
}

/**
 * Compute field-level differences between two objects.
 * Returns an array of {@link DiffEntry} for each field that changed.
 *
 * @param oldData - The previous state (or `null`)
 * @param newData - The new state (or `null`)
 * @param options - Optional configuration
 * @returns Array of field-level changes
 *
 * @example
 * ```ts
 * const diffs = computeDiff(
 *   { name: 'Alice', age: 30, email: 'a@x.com' },
 *   { name: 'Bob', age: 30, email: 'a@x.com' },
 * )
 * // → [{ field: 'name', from: 'Alice', to: 'Bob' }]
 *
 * // Ignore specific fields
 * const diffs = computeDiff(old, new, { ignoreFields: ['updatedAt'] })
 * ```
 */
export function computeDiff(
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  options?: ComputeDiffOptions,
): DiffEntry[] {
  if (!oldData && !newData) return [];

  const ignoreSet = new Set(options?.ignoreFields ?? []);
  const diffs: DiffEntry[] = [];

  if (!oldData && newData) {
    for (const [key, value] of Object.entries(newData)) {
      if (ignoreSet.has(key)) continue;
      diffs.push({ field: key, from: undefined, to: value });
    }
    return diffs;
  }

  if (oldData && !newData) {
    for (const [key, value] of Object.entries(oldData)) {
      if (ignoreSet.has(key)) continue;
      diffs.push({ field: key, from: value, to: undefined });
    }
    return diffs;
  }

  const allKeys = new Set([...Object.keys(oldData!), ...Object.keys(newData!)]);

  for (const key of allKeys) {
    if (ignoreSet.has(key)) continue;
    const oldVal = oldData![key];
    const newVal = newData![key];

    if (!deepEqual(oldVal, newVal)) {
      diffs.push({ field: key, from: oldVal, to: newVal });
    }
  }

  return diffs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === "object") {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, i) => deepEqual(val, b[i]));
    }

    if (Array.isArray(a) || Array.isArray(b)) return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Build a changes object for an audit entry based on the action type.
 *
 * - **INSERT**: Returns all new fields as values
 * - **UPDATE**: Returns only changed fields as `{ field: { from, to } }`
 * - **DELETE**: Returns all old fields as values
 *
 * @param action - The audit action (`'INSERT'`, `'UPDATE'`, `'DELETE'`, or custom)
 * @param oldData - Previous state
 * @param newData - New state
 * @param options - Optional diff options
 * @returns The changes object, or `null` if no changes
 *
 * @example
 * ```ts
 * buildChanges('INSERT', null, { id: 1, name: 'Alice' })
 * // → { id: 1, name: 'Alice' }
 *
 * buildChanges('UPDATE', { name: 'Alice' }, { name: 'Bob' })
 * // → { name: { from: 'Alice', to: 'Bob' } }
 *
 * buildChanges('DELETE', { id: 1, name: 'Alice' }, null)
 * // → { id: 1, name: 'Alice' }
 * ```
 */
// --- Custom diff function support ---

import type { ComputeChangesFn } from "./types.ts";

let _customComputeChanges: ComputeChangesFn | undefined;

/**
 * Set a custom compute changes function. Called by `withDrizzleAudit`.
 * @internal
 */
export function _setComputeChanges(fn: ComputeChangesFn | undefined): void {
  _customComputeChanges = fn;
}

/** Default UPDATE diff: shallow field comparison with `{ from, to }` format */
function defaultComputeChanges(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
): Record<string, unknown> | null {
  const diffs = computeDiff(oldData, newData);
  if (diffs.length === 0) return null;

  const changes: Record<string, unknown> = {};
  for (const diff of diffs) {
    changes[diff.field] = { from: diff.from, to: diff.to };
  }
  return changes;
}

/**
 * Build a changes object for an audit entry based on the action type.
 *
 * - **INSERT**: Returns all new fields as values
 * - **UPDATE**: Uses the configured `computeChanges` function (default: `{ field: { from, to } }`)
 * - **DELETE**: Returns all old fields as values
 *
 * @param action - The audit action (`'INSERT'`, `'UPDATE'`, `'DELETE'`, or custom)
 * @param oldData - Previous state
 * @param newData - New state
 * @returns The changes object, or `null` if no changes
 *
 * @example
 * ```ts
 * buildChanges('INSERT', null, { id: 1, name: 'Alice' })
 * // → { id: 1, name: 'Alice' }
 *
 * buildChanges('UPDATE', { name: 'Alice' }, { name: 'Bob' })
 * // → { name: { from: 'Alice', to: 'Bob' } }
 *
 * buildChanges('DELETE', { id: 1, name: 'Alice' }, null)
 * // → { id: 1, name: 'Alice' }
 * ```
 */
export function buildChanges(
  action: string,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (action === "INSERT" && newData) {
    return { ...newData };
  }

  if (action === "DELETE" && oldData) {
    return { ...oldData };
  }

  if ((action === "UPDATE" || (action !== "INSERT" && action !== "DELETE")) && oldData && newData) {
    const fn = _customComputeChanges ?? defaultComputeChanges;
    return fn(oldData, newData);
  }

  return null;
}
