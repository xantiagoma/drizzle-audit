import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

/**
 * GraphQL context factory wrapper for drizzle-audit.
 * Works with GraphQL Yoga, Apollo Server, and any GraphQL server
 * that accepts a context factory function.
 *
 * GraphQL Yoga:
 * ```ts
 * import { createYoga } from 'graphql-yoga'
 * import { drizzleAuditGraphQLContext } from 'drizzle-audit/middleware/graphql'
 *
 * const yoga = createYoga({
 *   context: drizzleAuditGraphQLContext((ctx) => ({
 *     userId: ctx.request.headers.get('x-user-id') ?? null,
 *     metadata: { operationName: ctx.params?.operationName },
 *   })),
 * })
 * ```
 *
 * Apollo Server:
 * ```ts
 * import { ApolloServer } from '@apollo/server'
 * import { drizzleAuditGraphQLContext } from 'drizzle-audit/middleware/graphql'
 *
 * const server = new ApolloServer({ typeDefs, resolvers })
 *
 * // In expressMiddleware or startStandaloneServer context:
 * context: drizzleAuditGraphQLContext(({ req }) => ({
 *   userId: req.headers['x-user-id'] ?? null,
 * }))
 * ```
 */
export function drizzleAuditGraphQLContext<TServerContext = any, TResult = any>(
  resolver: (serverContext: TServerContext) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
  contextFactory?: (
    serverContext: TServerContext,
    auditContext: DrizzleAuditContext,
  ) => TResult | Promise<TResult>,
): (serverContext: TServerContext) => Promise<TResult> {
  return async (serverContext) => {
    const auditCtx = await resolver(serverContext);

    // Set context via enterWith so it's available in all resolvers
    // GraphQL servers typically create a new async context per request
    auditStorage.enterWith(auditCtx);

    // If user provides a context factory, merge audit context into it
    if (contextFactory) {
      return contextFactory(serverContext, auditCtx);
    }

    // Default: return the audit context as part of the GraphQL context
    return { auditContext: auditCtx } as TResult;
  };
}

/**
 * GraphQL Yoga plugin for drizzle-audit.
 *
 * **Works best when Yoga is the top-level server.** When Yoga is embedded inside
 * another framework (e.g. Elysia, Express), the `onRequest` hook may not share
 * the same async context as resolvers. In that case, use `setDrizzleAuditContext()`
 * or `db.$audit.setContext()` inside Yoga's `context` factory instead:
 *
 * ```ts
 * // Recommended for embedded Yoga:
 * const yoga = createYoga({
 *   context: async ({ request }) => {
 *     setDrizzleAuditContext({ userId: ... });
 *     return { ... };
 *   },
 * })
 * ```
 *
 * ```ts
 * // Works when Yoga is the top-level server:
 * const yoga = createYoga({
 *   plugins: [
 *     drizzleAuditYogaPlugin((request) => ({
 *       userId: request.headers.get('x-user-id') ?? null,
 *     })),
 *   ],
 * })
 * ```
 */
export function drizzleAuditYogaPlugin(
  resolver: (request: Request) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
) {
  return {
    async onRequest({ request }: any) {
      const auditCtx = await resolver(request);
      auditStorage.enterWith(auditCtx);
    },
  };
}
