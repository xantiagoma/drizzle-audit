import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * Generic wrapper for background job handlers, queue workers, scheduled tasks,
 * and any function that needs audit context.
 *
 * Works with: BullMQ, Temporal activities, Inngest functions,
 * Cloudflare Workers scheduled handlers, cron jobs, etc.
 *
 * BullMQ:
 * ```ts
 * import { drizzleAuditHandler } from 'drizzle-audit/middleware/worker'
 *
 * new Worker('emails', drizzleAuditHandler(
 *   (job) => ({
 *     userId: job.data.triggeredBy ?? null,
 *     metadata: { jobId: job.id, queue: job.queueName },
 *   }),
 *   async (job) => {
 *     // audit context is active here
 *     await db.update(emails).set({ status: 'sent' }).where(...)
 *   },
 * ))
 * ```
 *
 * Temporal activity:
 * ```ts
 * import { drizzleAuditHandler } from 'drizzle-audit/middleware/worker'
 *
 * export const processOrder = drizzleAuditHandler(
 *   (orderId: string) => ({
 *     userId: 'system',
 *     metadata: { activity: 'processOrder', orderId },
 *   }),
 *   async (orderId: string) => {
 *     await db.update(orders).set({ status: 'processing' }).where(eq(orders.id, orderId))
 *   },
 * )
 * ```
 *
 * Inngest:
 * ```ts
 * import { drizzleAuditHandler } from 'drizzle-audit/middleware/worker'
 *
 * inngest.createFunction(
 *   { id: 'process-order' },
 *   { event: 'order/created' },
 *   drizzleAuditHandler(
 *     ({ event }) => ({
 *       userId: event.data.userId,
 *       metadata: { eventName: event.name, functionId: 'process-order' },
 *     }),
 *     async ({ event, step }) => {
 *       await step.run('update-status', async () => {
 *         await db.update(orders).set({ status: 'processing' }).where(...)
 *       })
 *     },
 *   ),
 * )
 * ```
 *
 * Cloudflare Workers scheduled:
 * ```ts
 * export default {
 *   scheduled: drizzleAuditHandler(
 *     (event) => ({
 *       userId: null,
 *       metadata: { cron: event.cron, scheduledTime: event.scheduledTime },
 *     }),
 *     async (event, env, ctx) => {
 *       await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
 *     },
 *   ),
 * }
 * ```
 */
export function drizzleAuditHandler<TArgs extends any[], TReturn>(
  resolver: (...args: TArgs) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
  handler: (...args: TArgs) => TReturn,
): (...args: TArgs) => Promise<Awaited<TReturn>> {
  return async (...args: TArgs) => {
    const ctx = await resolver(...args);
    return auditStorage.run(ctx, () => handler(...args)) as Promise<Awaited<TReturn>>;
  };
}

/**
 * Wraps any async function so it runs with a static audit context.
 * Simpler than `drizzleAuditHandler` when you don't need to derive context from args.
 *
 * ```ts
 * import { drizzleAuditWrap } from 'drizzle-audit/middleware/worker'
 *
 * const cleanup = drizzleAuditWrap(
 *   { userId: null, metadata: { trigger: 'cron' } },
 *   async () => {
 *     await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
 *   },
 * )
 *
 * // Later:
 * await cleanup()
 * ```
 */
export function drizzleAuditWrap<TArgs extends any[], TReturn>(
  context: DrizzleAuditContext,
  handler: (...args: TArgs) => TReturn,
): (...args: TArgs) => Promise<Awaited<TReturn>> {
  return async (...args: TArgs) => {
    return auditStorage.run(context, () => handler(...args)) as Promise<Awaited<TReturn>>;
  };
}
