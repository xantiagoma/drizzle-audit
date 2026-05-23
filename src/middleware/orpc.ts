import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * oRPC middleware for drizzle-audit context.
 *
 * ```ts
 * import { os } from '@orpc/server'
 * import { drizzleAuditORPCMiddleware } from 'drizzle-audit/middleware/orpc'
 *
 * const auditMiddleware = drizzleAuditORPCMiddleware((input, context, meta) => ({
 *   userId: context.user?.id ?? null,
 *   metadata: { path: meta?.path },
 * }))
 *
 * const procedure = os.use(auditMiddleware)
 * ```
 */
export function drizzleAuditORPCMiddleware<TContext = any>(
  resolver: (
    input: unknown,
    context: TContext,
    meta: any,
  ) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): (input: any, context: any, meta: any) => Promise<any> {
  return async (input, context, meta) => {
    const auditCtx = await resolver(input, context, meta);
    return auditStorage.run(auditCtx, () => meta.next({ context }));
  };
}
