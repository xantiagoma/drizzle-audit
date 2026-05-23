import type { IncomingMessage, ServerResponse } from "node:http";
import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * Generic audit middleware for Node.js HTTP servers.
 * Works with Express, Koa, Fastify, NestJS, and any framework
 * using the standard (req, res, next) middleware pattern.
 *
 * Express:
 * ```ts
 * import { drizzleAuditNodeMiddleware } from 'drizzle-audit/middleware/node'
 *
 * app.use(drizzleAuditNodeMiddleware((req) => ({
 *   userId: req.headers['x-user-id'] as string ?? null,
 *   metadata: {
 *     ip: req.headers['x-forwarded-for'] as string,
 *     method: req.method,
 *     path: req.url,
 *   },
 * })))
 * ```
 *
 * Fastify (as preHandler hook):
 * ```ts
 * fastify.addHook('preHandler', drizzleAuditNodeMiddleware((req) => ({
 *   userId: req.headers['x-user-id'] as string ?? null,
 * })))
 * ```
 *
 * Koa (wrap with koa-compatible adapter):
 * ```ts
 * app.use(drizzleAuditKoaMiddleware((ctx) => ({
 *   userId: ctx.get('x-user-id') ?? null,
 * })))
 * ```
 */
export function drizzleAuditNodeMiddleware(
  resolver: (req: IncomingMessage) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  return (req, _res, next) => {
    const resolvedOrPromise = resolver(req);

    if (resolvedOrPromise instanceof Promise) {
      resolvedOrPromise.then((ctx) => {
        auditStorage.run(ctx, next);
      });
    } else {
      auditStorage.run(resolvedOrPromise, next);
    }
  };
}

/**
 * Koa-style middleware for drizzle-audit context.
 * Koa uses (ctx, next) instead of (req, res, next).
 *
 * ```ts
 * import { drizzleAuditKoaMiddleware } from 'drizzle-audit/middleware/node'
 *
 * app.use(drizzleAuditKoaMiddleware((ctx) => ({
 *   userId: ctx.state.user?.id ?? null,
 *   metadata: { ip: ctx.ip, path: ctx.path },
 * })))
 * ```
 */
export function drizzleAuditKoaMiddleware(
  resolver: (ctx: any) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const auditCtx = await resolver(ctx);
    return auditStorage.run(auditCtx, next);
  };
}
