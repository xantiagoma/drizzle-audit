import { test, expect, describe, beforeEach } from "vitest";
import { drizzleAuditHandler, drizzleAuditWrap } from "../src/middleware/worker.ts";
import { useDrizzleAuditContext } from "../src/context.ts";
import { _setGlobalStorage } from "../src/audit-action-internal.ts";
import { drizzleAuditAction } from "../src/audit-action.ts";
import type { AuditEntry } from "../src/types.ts";

describe("drizzleAuditHandler", () => {
  let entries: AuditEntry[];

  beforeEach(() => {
    entries = [];
    _setGlobalStorage({
      async write(e: AuditEntry[]) {
        entries.push(...e);
      },
    });
  });

  test("wraps a handler with dynamic context from args (BullMQ style)", async () => {
    // Simulate BullMQ job
    interface Job {
      id: string;
      data: { triggeredBy: string; emailId: string };
      queueName: string;
    }

    const processor = drizzleAuditHandler(
      (job: Job) => ({
        userId: job.data.triggeredBy,
        metadata: { jobId: job.id, queue: job.queueName },
      }),
      async (job: Job) => {
        await drizzleAuditAction({ action: "SEND_EMAIL", metadata: { emailId: job.data.emailId } });
        return { sent: true };
      },
    );

    const result = await processor({
      id: "job_1",
      data: { triggeredBy: "u_123", emailId: "email_456" },
      queueName: "emails",
    });

    expect(result).toEqual({ sent: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe("u_123");
    expect((entries[0]!.metadata as any).jobId).toBe("job_1");
    expect((entries[0]!.metadata as any).queue).toBe("emails");
    expect((entries[0]!.metadata as any).emailId).toBe("email_456");
  });

  test("wraps a handler with multiple args (Temporal style)", async () => {
    const processOrder = drizzleAuditHandler(
      (orderId: string, _userId: string) => ({
        userId: _userId,
        metadata: { activity: "processOrder", orderId },
      }),
      async (orderId: string) => {
        await drizzleAuditAction({ action: "PROCESS_ORDER", rowId: orderId });
        return { processed: true };
      },
    );

    await processOrder("ord_789", "system");

    expect(entries[0]!.userId).toBe("system");
    expect((entries[0]!.metadata as any).activity).toBe("processOrder");
    expect(entries[0]!.rowId).toBe("ord_789");
  });

  test("context is cleaned up after handler completes", async () => {
    const handler = drizzleAuditHandler(
      () => ({ userId: "worker_temp" }),
      async () => {},
    );

    await handler();
    expect(useDrizzleAuditContext()).toBeNull();
  });

  test("context is isolated between concurrent handlers", async () => {
    const handler = drizzleAuditHandler(
      (id: string) => ({ userId: id }),
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        await drizzleAuditAction({ action: "CONCURRENT" });
      },
    );

    await Promise.all([handler("worker_a"), handler("worker_b")]);

    expect(entries).toHaveLength(2);
    const userIds = entries.map((e) => e.userId).sort();
    expect(userIds).toEqual(["worker_a", "worker_b"]);
  });

  test("supports async resolver", async () => {
    const handler = drizzleAuditHandler(
      async (jobId: string) => {
        await new Promise((r) => setTimeout(r, 5));
        return { userId: `resolved_${jobId}` };
      },
      async () => {
        await drizzleAuditAction({ action: "ASYNC_WORKER" });
      },
    );

    await handler("j_1");
    expect(entries[0]!.userId).toBe("resolved_j_1");
  });

  test("preserves handler return value", async () => {
    const handler = drizzleAuditHandler(
      (_x: number, _y: number) => ({ userId: null }),
      async (x: number, y: number) => x + y,
    );

    const result = await handler(3, 4);
    expect(result).toBe(7);
  });
});

describe("drizzleAuditWrap", () => {
  let entries: AuditEntry[];

  beforeEach(() => {
    entries = [];
    _setGlobalStorage({
      async write(e: AuditEntry[]) {
        entries.push(...e);
      },
    });
  });

  test("wraps a function with static context", async () => {
    const cleanup = drizzleAuditWrap({ userId: null, metadata: { trigger: "cron" } }, async () => {
      await drizzleAuditAction({ action: "CRON_CLEANUP", metadata: { deleted: 42 } });
    });

    await cleanup();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBeNull();
    expect((entries[0]!.metadata as any).trigger).toBe("cron");
    expect((entries[0]!.metadata as any).deleted).toBe(42);
  });

  test("passes through arguments", async () => {
    const process = drizzleAuditWrap({ userId: "system" }, async (batchSize: number) => {
      return { processed: batchSize };
    });

    const result = await process(100);
    expect(result).toEqual({ processed: 100 });
  });

  test("context is scoped to the wrapped function", async () => {
    const fn = drizzleAuditWrap({ userId: "scoped" }, async () => {
      expect(useDrizzleAuditContext()?.userId).toBe("scoped");
    });

    await fn();
    expect(useDrizzleAuditContext()).toBeNull();
  });
});
