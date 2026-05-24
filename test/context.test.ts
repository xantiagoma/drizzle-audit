import { test, expect, describe } from "vitest";
import {
  withDrizzleAuditContext,
  newDrizzleAuditContext,
  useDrizzleAuditContext,
  getDrizzleAuditContext,
  setDrizzleAuditContext,
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
  test("nesting merges — inner inherits outer metadata", async () => {
    await withDrizzleAuditContext({ userId: "outer", metadata: { ip: "1.2.3.4" } }, async () => {
      await withDrizzleAuditContext({ metadata: { operation: "edit" } }, async () => {
        const ctx = useDrizzleAuditContext()!;
        expect(ctx.userId).toBe("outer"); // inherited
        expect(ctx.metadata).toEqual({ ip: "1.2.3.4", operation: "edit" }); // merged
      });

      // Outer restored
      expect(useDrizzleAuditContext()!.userId).toBe("outer");
      expect(useDrizzleAuditContext()!.metadata).toEqual({ ip: "1.2.3.4" });
    });
  });

  test("inner userId overrides outer when provided", async () => {
    await withDrizzleAuditContext({ userId: "outer" }, async () => {
      await withDrizzleAuditContext({ userId: "inner" }, async () => {
        expect(useDrizzleAuditContext()!.userId).toBe("inner");
      });
      expect(useDrizzleAuditContext()!.userId).toBe("outer");
    });
  });

  test("works without existing context (no merge needed)", async () => {
    await withDrizzleAuditContext({ userId: "fresh" }, async () => {
      expect(useDrizzleAuditContext()!.userId).toBe("fresh");
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

  test("deep merges nested metadata objects", async () => {
    await withDrizzleAuditContext(
      { userId: "u_1", metadata: { request: { id: "r_1", method: "GET" }, ip: "1.2.3.4" } },
      async () => {
        await withDrizzleAuditContext(
          { metadata: { request: { path: "/api/users" }, extra: "data" } },
          async () => {
            const ctx = useDrizzleAuditContext()!;
            // request should be deep merged, not replaced
            expect((ctx.metadata as any).request).toEqual({
              id: "r_1",
              method: "GET",
              path: "/api/users",
            });
            expect((ctx.metadata as any).ip).toBe("1.2.3.4"); // preserved
            expect((ctx.metadata as any).extra).toBe("data"); // added
          },
        );
      },
    );
  });

  test("deep merge: override scalar values in nested objects", async () => {
    await withDrizzleAuditContext(
      { userId: "u_1", metadata: { config: { theme: "dark", lang: "en" } } },
      async () => {
        await withDrizzleAuditContext({ metadata: { config: { theme: "light" } } }, async () => {
          const ctx = useDrizzleAuditContext()!;
          expect((ctx.metadata as any).config).toEqual({
            theme: "light", // overridden
            lang: "en", // preserved
          });
        });
      },
    );
  });

  test("deep merge: arrays are replaced, not concatenated", async () => {
    await withDrizzleAuditContext({ userId: "u_1", metadata: { tags: ["a", "b"] } }, async () => {
      await withDrizzleAuditContext({ metadata: { tags: ["c"] } }, async () => {
        const ctx = useDrizzleAuditContext()!;
        expect((ctx.metadata as any).tags).toEqual(["c"]); // replaced entirely
      });
    });
  });
});

describe("newDrizzleAuditContext", () => {
  test("replaces existing context entirely", async () => {
    await withDrizzleAuditContext({ userId: "outer", metadata: { ip: "1.2.3.4" } }, async () => {
      await newDrizzleAuditContext({ userId: null, metadata: { trigger: "system" } }, async () => {
        const ctx = useDrizzleAuditContext()!;
        expect(ctx.userId).toBeNull(); // NOT inherited
        expect(ctx.metadata).toEqual({ trigger: "system" }); // NOT merged
        expect((ctx.metadata as any).ip).toBeUndefined(); // outer metadata gone
      });

      // Outer restored
      expect(useDrizzleAuditContext()!.userId).toBe("outer");
    });
  });

  test("works without existing context", async () => {
    await newDrizzleAuditContext({ userId: "fresh" }, async () => {
      expect(useDrizzleAuditContext()!.userId).toBe("fresh");
    });
  });
});

describe("setDrizzleAuditContext", () => {
  test("sets context for current async scope", async () => {
    // Run in an isolated async scope so enterWith doesn't leak
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        setDrizzleAuditContext({ userId: "imperative_user", metadata: { source: "test" } });
        const ctx = useDrizzleAuditContext();
        expect(ctx?.userId).toBe("imperative_user");
        expect((ctx?.metadata as any)?.source).toBe("test");
        resolve();
      }, 0);
    });
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

  test("deep merges nested metadata", async () => {
    await withDrizzleAuditContext(
      { userId: "u_1", metadata: { request: { id: "r_1", method: "GET" } } },
      async () => {
        addDrizzleAuditMetadata({ request: { path: "/api" } });
        const ctx = useDrizzleAuditContext()!;
        expect((ctx.metadata as any).request).toEqual({
          id: "r_1",
          method: "GET",
          path: "/api",
        });
      },
    );
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
