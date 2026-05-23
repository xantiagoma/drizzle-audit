import type { ShouldAuditFn, ShouldAuditContext } from "./types.ts";

/**
 * Creates a {@link ShouldAuditFn} that randomly samples a percentage of operations.
 *
 * @param rate - A number between 0 and 1. `0.3` = audit 30% of operations.
 * @returns A sampling function
 *
 * @example
 * ```ts
 * tables: {
 *   pageViews: { shouldAudit: sampleRate(0.1) },  // audit 10%
 * }
 * ```
 */
export function sampleRate(rate: number): ShouldAuditFn {
  return () => Math.random() < rate;
}

/**
 * Creates a {@link ShouldAuditFn} that samples a percentage of operations,
 * but always audits when the override condition is true.
 *
 * @param rate - Base sampling rate (0-1)
 * @param override - Condition that forces auditing when true
 * @returns A sampling function
 *
 * @example
 * ```ts
 * tables: {
 *   requestLogs: {
 *     shouldAudit: sampleWithOverride(0.05, (ctx) => ctx.metadata?.isError === true),
 *   },
 *   pageViews: {
 *     shouldAudit: sampleWithOverride(0.1, (ctx) => ctx.userId === 'admin'),
 *   },
 * }
 * ```
 */
export function sampleWithOverride(
  rate: number,
  override: (context: ShouldAuditContext) => boolean,
): ShouldAuditFn {
  return (ctx) => {
    if (override(ctx)) return true;
    return Math.random() < rate;
  };
}

/**
 * Always audit. Useful for making intent explicit in config.
 *
 * @example
 * ```ts
 * tables: {
 *   payments: { shouldAudit: alwaysAudit() },
 * }
 * ```
 */
export function alwaysAudit(): ShouldAuditFn {
  return () => true;
}

/**
 * Never audit. Useful for explicitly disabling a table without removing it from config.
 *
 * @example
 * ```ts
 * tables: {
 *   tempData: { shouldAudit: neverAudit() },
 * }
 * ```
 */
export function neverAudit(): ShouldAuditFn {
  return () => false;
}
