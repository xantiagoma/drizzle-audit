import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

export interface ElysiaAuditPluginOptions {
  getContext: (ctx: {
    request: Request;
    headers: Record<string, string>;
  }) => DrizzleAuditContext | Promise<DrizzleAuditContext>;
}

/**
 * Creates an Elysia-compatible plugin for drizzle-audit context.
 *
 * Uses two lifecycle hooks:
 * 1. `derive` (async) — resolves audit context from the request, attaches to `ctx.auditContext`
 * 2. `onBeforeHandle` (sync) — calls `enterWith` in the **handler's** async scope
 *
 * This split is necessary because async `derive` runs in a different async context
 * than the handler. If `enterWith` is called inside async `derive`, the ALS store
 * is lost by the time the handler runs.
 *
 * @example
 * ```ts
 * import Elysia from 'elysia'
 * import { drizzleAuditPlugin } from 'drizzle-audit/middleware/elysia'
 *
 * const app = new Elysia()
 *   .use(drizzleAuditPlugin({
 *     getContext: async ({ request }) => {
 *       const session = await getSession(request);
 *       return { userId: session?.user?.id ?? null };
 *     },
 *   }))
 *   .post('/api/users', ({ auditContext }) => {
 *     // auditContext available on Elysia ctx
 *     // ALS context is set — db operations are attributed to userId
 *   })
 * ```
 */
export function drizzleAuditPlugin(options: ElysiaAuditPluginOptions) {
  return (app: any) =>
    app
      // Step 1: Resolve context (async OK — runs in derive's async scope)
      .derive({ as: "global" }, async ({ request }: { request: Request }) => {
        const headers = Object.fromEntries(request.headers);
        const auditContext = await options.getContext({ request, headers });
        return { auditContext };
      })
      // Step 2: Set ALS context (sync — runs in handler's async scope)
      .onBeforeHandle(
        { as: "global" },
        ({ auditContext }: { auditContext: DrizzleAuditContext }) => {
          if (auditContext) {
            auditStorage.enterWith(auditContext);
          }
        },
      );
}
