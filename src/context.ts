import { AsyncLocalStorage } from "node:async_hooks";
import { createDefu } from "defu";
import type { DrizzleAuditContext, MetadataMergeFn } from "./types.ts";

// --- Default merge strategy (defu with array replacement) ---

const defaultMerge = createDefu((obj, key, value) => {
  if (Array.isArray(value)) {
    (obj as any)[key] = value;
    return true;
  }
});

const defaultMetadataMerge: MetadataMergeFn = (override, base) =>
  defaultMerge(override, base) as Record<string, unknown>;

// --- Global merge function (configurable via withDrizzleAudit options) ---

let _mergeFn: MetadataMergeFn = defaultMetadataMerge;

/**
 * Set the global metadata merge function. Called by `withDrizzleAudit`.
 * @internal
 */
export function _setMetadataMerge(fn: MetadataMergeFn | undefined): void {
  _mergeFn = fn ?? defaultMetadataMerge;
}

function mergeMetadata(
  override: Record<string, unknown> | null | undefined,
  base: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!override && !base) return null;
  if (!override) return base ? { ...base } : null;
  if (!base) return { ...override };
  return _mergeFn(override, base);
}

// --- AsyncLocalStorage ---

const ALS_KEY = Symbol.for("drizzle-audit:als");

const g = globalThis as any;
if (!g[ALS_KEY]) {
  g[ALS_KEY] = new AsyncLocalStorage<DrizzleAuditContext>();
}

const auditStorage: AsyncLocalStorage<DrizzleAuditContext> = g[ALS_KEY];

/**
 * Get the current audit context, or `null` if no context is active.
 * Safe to call anywhere — never throws.
 *
 * @returns The current {@link DrizzleAuditContext} or `null`
 *
 * @example
 * ```ts
 * const ctx = useDrizzleAuditContext()
 * if (ctx) {
 *   console.log('Current user:', ctx.userId)
 * }
 * ```
 */
export function useDrizzleAuditContext(): DrizzleAuditContext | null {
  return auditStorage.getStore() ?? null;
}

/**
 * Get the current audit context. Throws if no context is active.
 * Use in code paths where context is required.
 *
 * @returns The current {@link DrizzleAuditContext}
 * @throws Error if no audit context is active
 *
 * @example
 * ```ts
 * const ctx = getDrizzleAuditContext() // throws if not in a context
 * console.log('User:', ctx.userId)
 * ```
 */
export function getDrizzleAuditContext(): DrizzleAuditContext {
  const ctx = auditStorage.getStore();
  if (!ctx) {
    throw new Error(
      "[drizzle-audit] No audit context found. " +
        "Use withDrizzleAuditContext() or a framework middleware to establish context.",
    );
  }
  return ctx;
}

/**
 * Run a function within an audit context scope that **merges** with any existing context.
 * `userId` is overridden only if explicitly provided. Metadata is deep merged.
 *
 * @param context - Partial context to merge (userId optional, metadata deep merged)
 * @param fn - The async function to run within the context
 * @returns The return value of `fn`
 *
 * @example
 * ```ts
 * // Outer: { userId: "admin", metadata: { ip: "1.2.3.4" } }
 * await withDrizzleAuditContext({ metadata: { operation: "edit" } }, async () => {
 *   // Inner: { userId: "admin", metadata: { ip: "1.2.3.4", operation: "edit" } }
 * })
 * ```
 */
export async function withDrizzleAuditContext<T>(
  context: Partial<DrizzleAuditContext> & Pick<DrizzleAuditContext, never>,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = auditStorage.getStore();
  const merged: DrizzleAuditContext = {
    userId: context.userId !== undefined ? context.userId : (existing?.userId ?? null),
    metadata: mergeMetadata(context.metadata, existing?.metadata),
  };
  return auditStorage.run(merged, fn);
}

/**
 * Run a function within a **fresh** audit context scope, ignoring any existing context.
 * Use this when you want to start clean (e.g. a system action that should not
 * inherit the current user's context).
 *
 * @param context - The audit context to set (replaces any existing context)
 * @param fn - The async function to run within the context
 * @returns The return value of `fn`
 *
 * @example
 * ```ts
 * await newDrizzleAuditContext(
 *   { userId: null, metadata: { trigger: 'system' } },
 *   async () => {
 *     // Clean context — nothing from outer request leaks in
 *   },
 * )
 * ```
 */
export async function newDrizzleAuditContext<T>(
  context: DrizzleAuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  return auditStorage.run(context, fn);
}

/**
 * Merge additional metadata into the current audit context (deep merge).
 * Does nothing if no context is active.
 *
 * @param metadata - Key-value pairs to deep merge into existing metadata
 *
 * @example
 * ```ts
 * addDrizzleAuditMetadata({ operation: 'create-order', orderId: 'ord_123' })
 * ```
 */
export function addDrizzleAuditMetadata(metadata: Record<string, unknown>): void {
  const ctx = auditStorage.getStore();
  if (ctx) {
    ctx.metadata = mergeMetadata(metadata, ctx.metadata);
  }
}

/**
 * Resolve the effective audit context using the fallback chain:
 * 1. Explicit context (if `userId` is provided)
 * 2. AsyncLocalStorage implicit context
 * 3. Empty default `{ userId: null }`
 *
 * @param explicit - Optional explicit overrides
 * @returns The resolved {@link DrizzleAuditContext}
 * @internal
 */
export function resolveContext(explicit?: Partial<DrizzleAuditContext>): DrizzleAuditContext {
  const implicit = auditStorage.getStore();

  if (explicit?.userId !== undefined) {
    return {
      userId: explicit.userId,
      metadata: mergeMetadata(explicit.metadata, implicit?.metadata),
    };
  }

  if (implicit) {
    return {
      ...implicit,
      metadata: explicit?.metadata
        ? mergeMetadata(explicit.metadata, implicit.metadata)
        : implicit.metadata,
    };
  }

  return {
    userId: null,
    metadata: explicit?.metadata ?? null,
  };
}

export { auditStorage };
