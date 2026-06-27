import { Elysia } from "elysia";

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
 * Returns a **named Elysia instance** (`name: "drizzle-audit"`) rather than a
 * functional `(app) => app` plugin. This is the idiomatic Elysia plugin shape:
 * composing it with `.use()` merges its types into the consumer and **preserves
 * the consuming app's route types** — critical for Eden Treaty end-to-end type
 * safety. A functional `(app: any) => any` plugin instead collapses the whole
 * consuming `App` type to `any`. The name also enables Elysia's plugin de-dup.
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
  return (
    new Elysia({ name: "drizzle-audit" })
      // Step 1: Resolve context (async OK — runs in derive's async scope)
      .derive({ as: "global" }, async ({ request }) => {
        const headers = Object.fromEntries(request.headers);
        const auditContext = await options.getContext({ request, headers });
        return { auditContext };
      })
      // Step 2: Set ALS context (sync — runs in handler's async scope).
      // `auditContext` is typed via the derive above, so no annotation needed.
      .onBeforeHandle({ as: "global" }, ({ auditContext }) => {
        if (auditContext) {
          auditStorage.enterWith(auditContext);
        }
      })
  );
}
