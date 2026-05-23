import { test, expect, describe } from "vitest";
import {
  withDrizzleAuditContext,
  useDrizzleAuditContext,
  getDrizzleAuditContext,
  addDrizzleAuditMetadata,
  resolveContext,
} from "../src/context.ts";

describe("useDrizzleAuditContext", () => {
  test("returns null when no context is active", () => {
    expect(useDrizzleAuditContext()).toBeNull();
  });

  test("returns context inside withDrizzleAuditContext", async () => {
    await withDrizzleAuditContext({ userId: "u_1" }, async () => {
      const ctx = useDrizzleAuditContext();
      expect(ctx).not.toBeNull();
      expect(ctx!.userId).toBe("u_1");
    });
  });

  test("returns null after withDrizzleAuditContext exits", async () => {
    await withDrizzleAuditContext({ userId: "u_1" }, async () => {});
    expect(useDrizzleAuditContext()).toBeNull();
  });
});

describe("getDrizzleAuditContext", () => {
  test("throws when no context is active", () => {
    expect(() => getDrizzleAuditContext()).toThrow("[drizzle-audit]");
  });

  test("returns context inside withDrizzleAuditContext", async () => {
    await withDrizzleAuditContext({ userId: "u_1" }, async () => {
      const ctx = getDrizzleAuditContext();
      expect(ctx.userId).toBe("u_1");
    });
  });
});

describe("withDrizzleAuditContext", () => {
  test("nesting works — inner shadows outer", async () => {
    await withDrizzleAuditContext({ userId: "outer" }, async () => {
      expect(useDrizzleAuditContext()!.userId).toBe("outer");

      await withDrizzleAuditContext({ userId: "inner" }, async () => {
        expect(useDrizzleAuditContext()!.userId).toBe("inner");
      });

      expect(useDrizzleAuditContext()!.userId).toBe("outer");
    });
  });

  test("propagates through async boundaries", async () => {
    await withDrizzleAuditContext({ userId: "async_user" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(useDrizzleAuditContext()!.userId).toBe("async_user");
    });
  });

  test("isolates between parallel contexts", async () => {
    const results: string[] = [];

    await Promise.all([
      withDrizzleAuditContext({ userId: "a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(useDrizzleAuditContext()!.userId!);
      }),
      withDrizzleAuditContext({ userId: "b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(useDrizzleAuditContext()!.userId!);
      }),
    ]);

    expect(results).toContain("a");
    expect(results).toContain("b");
  });
});

describe("addDrizzleAuditMetadata", () => {
  test("merges metadata into existing context", async () => {
    await withDrizzleAuditContext({ userId: "u_1", metadata: { ip: "1.2.3.4" } }, async () => {
      addDrizzleAuditMetadata({ requestId: "req_123" });
      const ctx = useDrizzleAuditContext()!;
      expect(ctx.metadata).toEqual({ ip: "1.2.3.4", requestId: "req_123" });
    });
  });

  test("does nothing when no context is active", () => {
    expect(() => addDrizzleAuditMetadata({ foo: "bar" })).not.toThrow();
  });
});

describe("resolveContext", () => {
  test("returns empty context when nothing is available", () => {
    const ctx = resolveContext();
    expect(ctx.userId).toBeNull();
    expect(ctx.metadata).toBeNull();
  });

  test("uses ALS context when available", async () => {
    await withDrizzleAuditContext({ userId: "u_1", metadata: { ip: "1.2.3.4" } }, async () => {
      const ctx = resolveContext();
      expect(ctx.userId).toBe("u_1");
      expect(ctx.metadata).toEqual({ ip: "1.2.3.4" });
    });
  });

  test("explicit userId overrides ALS", async () => {
    await withDrizzleAuditContext({ userId: "als_user" }, async () => {
      const ctx = resolveContext({ userId: "explicit_user" });
      expect(ctx.userId).toBe("explicit_user");
    });
  });

  test("explicit metadata merges with ALS", async () => {
    await withDrizzleAuditContext({ userId: "u_1", metadata: { ip: "1.2.3.4" } }, async () => {
      const ctx = resolveContext({ metadata: { action: "test" } });
      expect(ctx.metadata).toEqual({ ip: "1.2.3.4", action: "test" });
    });
  });
});
