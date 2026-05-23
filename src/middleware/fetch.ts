import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * Generic audit middleware for any WHATWG Request/Response handler.
 * Works with Bun.serve, itty-router, Cloudflare Workers, Deno.serve, etc.
 *
 * Usage with Bun.serve:
 * ```ts
 * Bun.serve({
 *   fetch: drizzleAuditFetch(
 *     (req) => ({
 *       userId: req.headers.get('x-user-id'),
 *       metadata: { ip: req.headers.get('x-forwarded-for') },
 *     }),
 *     (req) => {
 *       // your handler — audit context is active here
 *       return new Response('ok');
 *     },
 *   ),
 * });
 * ```
 *
 * Usage with itty-router:
 * ```ts
 * router.all('*', drizzleAuditFetchMiddleware((req) => ({
 *   userId: req.headers.get('x-user-id'),
 * })));
 * ```
 */
export function drizzleAuditFetch(
  resolver: (request: Request) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const ctx = await resolver(request);
    return auditStorage.run(ctx, () => handler(request));
  };
}

/**
 * Middleware-style wrapper for routers that use a next() pattern with Request objects.
 * Wraps the downstream handler in an AsyncLocalStorage scope.
 *
 * For routers that pass (request, next) or similar patterns:
 * ```ts
 * app.use(drizzleAuditFetchMiddleware((req) => ({
 *   userId: req.headers.get('x-user-id'),
 * })));
 * ```
 */
export function drizzleAuditFetchMiddleware(
  resolver: (request: Request) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): (request: Request, next: () => Promise<Response>) => Promise<Response> {
  return async (request: Request, next: () => Promise<Response>) => {
    const ctx = await resolver(request);
    return auditStorage.run(ctx, next);
  };
}
