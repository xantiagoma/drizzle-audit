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
 * Uses `derive` pattern to establish audit context for each request.
 * The context is set via AsyncLocalStorage and available to all
 * downstream handlers and audit operations.
 *
 * Usage:
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
 * ```
 */
export function drizzleAuditPlugin(options: ElysiaAuditPluginOptions) {
  return (app: any) =>
    app.derive(async ({ request }: { request: Request }) => {
      const headers = Object.fromEntries(request.headers);
      const ctx = await options.getContext({ request, headers });
      auditStorage.enterWith(ctx);
      return { auditContext: ctx };
    });
}
