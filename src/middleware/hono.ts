import { auditStorage } from "../context.ts";
import type { DrizzleAuditContext } from "../types.ts";

type HonoContext = any;
type HonoMiddlewareHandler = (c: HonoContext, next: () => Promise<void>) => Promise<void>;

export function drizzleAuditMiddleware(
  resolver: (c: HonoContext) => DrizzleAuditContext | Promise<DrizzleAuditContext>,
): HonoMiddlewareHandler {
  return async (c, next) => {
    const ctx = await resolver(c);
    await auditStorage.run(ctx, next);
  };
}
