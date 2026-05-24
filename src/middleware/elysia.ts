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
 * Resolves audit context in `derive` and exposes it as `ctx.auditContext`.
 * Sets AsyncLocalStorage context via `enterWith` in `onBeforeHandle` so it's
 * available in handlers and downstream code (including embedded frameworks).
 *
 * For embedded async frameworks (e.g. GraphQL Yoga inside Elysia), the ALS
 * context may not propagate. In those cases, use `setDrizzleAuditContext()`
 * or `db.$audit.setContext()` inside the embedded framework's context factory.
 *
 * @example
 * ```ts
 * import Elysia from 'elysia'
 * import { drizzleAuditPlugin } from 'drizzle-audit/middleware/elysia'
 *
 * const app = new Elysia()
 *   .use(drizzleAuditPlugin({
 *     getContext: ({ headers }) => ({
 *       userId: headers['x-user-id'] ?? null,
 *     }),
 *   }))
 *   .get('/api/users', ({ auditContext }) => {
 *     // auditContext is available on the Elysia context
 *     // ALS context is also set for db operations
 *   })
 * ```
 */
export function drizzleAuditPlugin(options: ElysiaAuditPluginOptions) {
  return (app: any) =>
    app.derive({ as: "global" }, async ({ request }: { request: Request }) => {
      const headers = Object.fromEntries(request.headers);
      const auditContext = await options.getContext({ request, headers });
      // Set ALS context here — derive runs in the same async context as the handler
      auditStorage.enterWith(auditContext);
      return { auditContext };
    });
}
