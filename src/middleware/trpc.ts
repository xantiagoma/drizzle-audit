import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * tRPC middleware for drizzle-audit context.
 * Returns a middleware function compatible with tRPC's middleware signature.
 *
 * ```ts
 * import { initTRPC } from '@trpc/server'
 * import { drizzleAuditTRPCMiddleware } from 'drizzle-audit/middleware/trpc'
 *
 * const t = initTRPC.context<Context>().create()
 *
 * const auditMiddleware = t.middleware(
 *   drizzleAuditTRPCMiddleware((opts) => ({
 *     userId: opts.ctx.user?.id ?? null,
 *     metadata: { path: opts.path, type: opts.type },
 *   }))
 * )
 *
 * // Apply to procedures
 * const protectedProcedure = t.procedure.use(auditMiddleware)
 * ```
 */
export function drizzleAuditTRPCMiddleware<TContext = any>(
  resolver: (opts: {
    ctx: TContext;
    path: string;
    type: string;
    input: unknown;
    next: Function;
  }) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): (opts: any) => Promise<any> {
  return async (opts) => {
    const auditCtx = await resolver(opts);
    return auditStorage.run(auditCtx, () => opts.next());
  };
}
