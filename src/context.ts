import { AsyncLocalStorage } from "node:async_hooks";
import type { DrizzleAuditContext } from "./types.ts";

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
 * Run a function within an audit context scope.
 * The context is automatically cleaned up when the function completes.
 * Contexts can be nested — inner scopes shadow outer ones.
 *
 * @param context - The audit context to set for this scope
 * @param fn - The async function to run within the context
 * @returns The return value of `fn`
 *
 * @example
 * ```ts
 * // Web request handler
 * await withDrizzleAuditContext(
 *   { userId: req.user.id, metadata: { ip: req.ip } },
 *   async () => {
 *     await db.insert(users).values({ name: 'Alice' }).returning()
 *     // audit entry will include userId and metadata
 *   },
 * )
 *
 * // Background job
 * await withDrizzleAuditContext(
 *   { userId: 'system', metadata: { job: 'cleanup' } },
 *   async () => {
 *     await db.delete(sessions).where(expired)
 *   },
 * )
 * ```
 */
export async function withDrizzleAuditContext<T>(
  context: DrizzleAuditContext,
  fn: () => Promise<T>,
): Promise<T> {
  return auditStorage.run(context, fn);
}

/**
 * Merge additional metadata into the current audit context.
 * Does nothing if no context is active.
 *
 * @param metadata - Key-value pairs to merge into existing metadata
 *
 * @example
 * ```ts
 * // In a request handler, after middleware sets the base context
 * addDrizzleAuditMetadata({ operation: 'create-order', orderId: 'ord_123' })
 * ```
 */
export function addDrizzleAuditMetadata(metadata: Record<string, unknown>): void {
  const ctx = auditStorage.getStore();
  if (ctx) {
    ctx.metadata = { ...ctx.metadata, ...metadata };
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
      metadata: { ...implicit?.metadata, ...explicit.metadata },
    };
  }

  if (implicit) {
    return {
      ...implicit,
      metadata: explicit?.metadata
        ? { ...implicit.metadata, ...explicit.metadata }
        : implicit.metadata,
    };
  }

  return {
    userId: null,
    metadata: explicit?.metadata ?? null,
  };
}

export { auditStorage };
