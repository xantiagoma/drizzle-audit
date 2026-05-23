import { test, expect, describe, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import { Elysia } from "elysia";
import { drizzleAuditMiddleware } from "../src/middleware/hono.ts";
import { drizzleAuditPlugin } from "../src/middleware/elysia.ts";
import { drizzleAuditFetch, drizzleAuditFetchMiddleware } from "../src/middleware/fetch.ts";
import { drizzleAuditNodeMiddleware, drizzleAuditKoaMiddleware } from "../src/middleware/node.ts";
import { useDrizzleAuditContext, addDrizzleAuditMetadata } from "../src/context.ts";
import { _setGlobalStorage } from "../src/audit-action-internal.ts";
import { drizzleAuditAction } from "../src/audit-action.ts";
import type { AuditEntry } from "../src/types.ts";

describe("drizzleAuditMiddleware (Hono)", () => {
  let entries: AuditEntry[];
  const storage = {
    async write(e: AuditEntry[]) {
      entries.push(...e);
    },
  };

  beforeEach(() => {
    entries = [];
    _setGlobalStorage(storage);
  });

  test("sets context from request headers", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware((c) => ({
          userId: c.req.header("x-user-id") ?? null,
          metadata: { path: c.req.path, method: c.req.method },
        })),
      )
      .get("/api/test", async (c) => {
        await drizzleAuditAction({ action: "TEST_ACTION" });
        return c.json({ ok: true });
      });

    const res = await app.request("/api/test", {
      headers: { "x-user-id": "u_hono_123" },
    });

    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe("u_hono_123");
    expect(entries[0]!.action).toBe("TEST_ACTION");
    expect((entries[0]!.metadata as any).path).toBe("/api/test");
    expect((entries[0]!.metadata as any).method).toBe("GET");
  });

  test("context is isolated between parallel requests", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware((c) => ({
          userId: c.req.header("x-user-id") ?? null,
        })),
      )
      .get("/api/test", async (c) => {
        await drizzleAuditAction({ action: "REQUEST" });
        return c.json({ ok: true });
      });

    const [res1, res2] = await Promise.all([
      app.request("/api/test", { headers: { "x-user-id": "user_a" } }),
      app.request("/api/test", { headers: { "x-user-id": "user_b" } }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(entries).toHaveLength(2);

    const userIds = entries.map((e) => e.userId).sort();
    expect(userIds).toEqual(["user_a", "user_b"]);
  });

  test("context is cleaned up after request", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware(() => ({ userId: "u_temp" })),
      )
      .get("/", (c) => c.json({ ok: true }));

    await app.request("/");
    expect(useDrizzleAuditContext()).toBeNull();
  });

  test("supports async context resolver", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware(async (c) => {
          await new Promise((r) => setTimeout(r, 5));
          return { userId: c.req.header("x-user-id") ?? null };
        }),
      )
      .post("/api/action", async (c) => {
        await drizzleAuditAction({ action: "ASYNC_CTX" });
        return c.json({ ok: true });
      });

    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "x-user-id": "u_async" },
    });

    expect(res.status).toBe(200);
    expect(entries[0]!.userId).toBe("u_async");
  });

  test("addDrizzleAuditMetadata merges into context", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware(() => ({
          userId: "u_1",
          metadata: { ip: "1.2.3.4" },
        })),
      )
      .post("/api/orders", async (c) => {
        addDrizzleAuditMetadata({ operation: "create-order", orderId: "ord_123" });
        await drizzleAuditAction({ action: "CREATE_ORDER" });
        return c.json({ ok: true });
      });

    await app.request("/api/orders", { method: "POST" });

    expect((entries[0]!.metadata as any).ip).toBe("1.2.3.4");
    expect((entries[0]!.metadata as any).operation).toBe("create-order");
    expect((entries[0]!.metadata as any).orderId).toBe("ord_123");
  });

  test("testClient works with typed routes", async () => {
    const app = new Hono()
      .use(
        "*",
        drizzleAuditMiddleware((c) => ({
          userId: c.req.header("x-user-id") ?? null,
        })),
      )
      .get("/health", (c) => c.json({ status: "ok" }));

    const client = testClient(app);
    const res = await client.health.$get({}, { headers: { "x-user-id": "u_typed" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("drizzleAuditPlugin (Elysia)", () => {
  let entries: AuditEntry[];
  const storage = {
    async write(e: AuditEntry[]) {
      entries.push(...e);
    },
  };

  beforeEach(() => {
    entries = [];
    _setGlobalStorage(storage);
  });

  test("exposes auditContext on handler context via derive", async () => {
    let capturedUserId: string | null = null;
    let capturedMetadata: any = null;

    const app = new Elysia()
      .use(
        drizzleAuditPlugin({
          getContext: ({ headers }) => ({
            userId: headers["x-user-id"] ?? null,
            metadata: { ip: headers["x-forwarded-for"] },
          }),
        }),
      )
      .get("/api/test", async ({ auditContext }) => {
        capturedUserId = auditContext.userId;
        capturedMetadata = auditContext.metadata;
        return { ok: true };
      });

    const res = await app.handle(
      new Request("http://localhost/api/test", {
        headers: {
          "x-user-id": "u_elysia_456",
          "x-forwarded-for": "1.2.3.4",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedUserId).toBe("u_elysia_456");
    expect(capturedMetadata).toEqual({ ip: "1.2.3.4" });
  });

  test("works with POST requests", async () => {
    let capturedUserId: string | null = null;

    const app = new Elysia()
      .use(
        drizzleAuditPlugin({
          getContext: ({ headers }) => ({
            userId: headers["x-user-id"] ?? null,
          }),
        }),
      )
      .post("/api/users", async ({ auditContext }) => {
        capturedUserId = auditContext.userId;
        return { id: 1 };
      });

    const res = await app.handle(
      new Request("http://localhost/api/users", {
        method: "POST",
        headers: {
          "x-user-id": "admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Alice" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedUserId).toBe("admin");
  });

  test("exposes auditContext on elysia context", async () => {
    let capturedCtx: any = null;

    const app = new Elysia()
      .use(
        drizzleAuditPlugin({
          getContext: ({ headers }) => ({
            userId: headers["x-user-id"] ?? null,
          }),
        }),
      )
      .get("/api/test", async ({ auditContext }) => {
        capturedCtx = auditContext;
        return { ok: true };
      });

    await app.handle(
      new Request("http://localhost/api/test", {
        headers: { "x-user-id": "u_789" },
      }),
    );

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.userId).toBe("u_789");
  });
});

describe("drizzleAuditFetch (generic WHATWG)", () => {
  let entries: AuditEntry[];
  const storage = {
    async write(e: AuditEntry[]) {
      entries.push(...e);
    },
  };

  beforeEach(() => {
    entries = [];
    _setGlobalStorage(storage);
  });

  test("wraps a fetch handler with audit context", async () => {
    const handler = drizzleAuditFetch(
      (req) => ({
        userId: req.headers.get("x-user-id"),
        metadata: { url: req.url },
      }),
      async () => {
        await drizzleAuditAction({ action: "FETCH_HANDLER" });
        return new Response("ok");
      },
    );

    const res = await handler(
      new Request("http://localhost/api/test", {
        headers: { "x-user-id": "u_fetch_123" },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe("u_fetch_123");
    expect((entries[0]!.metadata as any).url).toBe("http://localhost/api/test");
  });

  test("context is cleaned up after handler", async () => {
    const handler = drizzleAuditFetch(
      () => ({ userId: "temp" }),
      async () => new Response("ok"),
    );

    await handler(new Request("http://localhost/"));
    expect(useDrizzleAuditContext()).toBeNull();
  });

  test("drizzleAuditFetchMiddleware wraps next()", async () => {
    const middleware = drizzleAuditFetchMiddleware((req) => ({
      userId: req.headers.get("x-user-id"),
    }));

    const req = new Request("http://localhost/", {
      headers: { "x-user-id": "u_mw" },
    });

    const res = await middleware(req, async () => {
      const ctx = useDrizzleAuditContext();
      return new Response(ctx?.userId ?? "no-context");
    });

    expect(await res.text()).toBe("u_mw");
  });

  test("supports async resolver", async () => {
    const handler = drizzleAuditFetch(
      async (req) => {
        await new Promise((r) => setTimeout(r, 5));
        return { userId: req.headers.get("x-user-id") };
      },
      async () => {
        await drizzleAuditAction({ action: "ASYNC_FETCH" });
        return new Response("ok");
      },
    );

    await handler(
      new Request("http://localhost/", {
        headers: { "x-user-id": "u_async_fetch" },
      }),
    );

    expect(entries[0]!.userId).toBe("u_async_fetch");
  });
});

describe("drizzleAuditNodeMiddleware (Express/Fastify/Node HTTP)", () => {
  let entries: AuditEntry[];
  const storage = {
    async write(e: AuditEntry[]) {
      entries.push(...e);
    },
  };

  beforeEach(() => {
    entries = [];
    _setGlobalStorage(storage);
  });

  test("sets context for downstream handlers via real http server", async () => {
    const middleware = drizzleAuditNodeMiddleware((req) => ({
      userId: (req.headers["x-user-id"] as string) ?? null,
      metadata: { method: req.method, path: req.url },
    }));

    const { port, close } = await startServer((req, res) => {
      middleware(req, res, async () => {
        await drizzleAuditAction({ action: "NODE_TEST" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { "x-user-id": "u_node_123" },
    });

    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe("u_node_123");
    expect(entries[0]!.action).toBe("NODE_TEST");
    expect((entries[0]!.metadata as any).method).toBe("GET");
    expect((entries[0]!.metadata as any).path).toBe("/api/test");

    close();
  });

  test("context is isolated between requests", async () => {
    const middleware = drizzleAuditNodeMiddleware((req) => ({
      userId: (req.headers["x-user-id"] as string) ?? null,
    }));

    const { port, close } = await startServer((req, res) => {
      middleware(req, res, async () => {
        await drizzleAuditAction({ action: "NODE_REQ" });
        res.writeHead(200);
        res.end("ok");
      });
    });

    await Promise.all([
      fetch(`http://localhost:${port}/`, { headers: { "x-user-id": "node_a" } }),
      fetch(`http://localhost:${port}/`, { headers: { "x-user-id": "node_b" } }),
    ]);

    expect(entries).toHaveLength(2);
    const userIds = entries.map((e) => e.userId).sort();
    expect(userIds).toEqual(["node_a", "node_b"]);

    close();
  });

  test("supports async resolver", async () => {
    const middleware = drizzleAuditNodeMiddleware(async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      return { userId: (req.headers["x-user-id"] as string) ?? null };
    });

    const { port, close } = await startServer((req, res) => {
      middleware(req, res, async () => {
        await drizzleAuditAction({ action: "ASYNC_NODE" });
        res.writeHead(200);
        res.end("ok");
      });
    });

    await fetch(`http://localhost:${port}/`, { headers: { "x-user-id": "u_async_node" } });

    expect(entries[0]!.userId).toBe("u_async_node");

    close();
  });
});

describe("drizzleAuditKoaMiddleware", () => {
  let entries: AuditEntry[];
  const storage = {
    async write(e: AuditEntry[]) {
      entries.push(...e);
    },
  };

  beforeEach(() => {
    entries = [];
    _setGlobalStorage(storage);
  });

  test("sets context from koa-style ctx object", async () => {
    const middleware = drizzleAuditKoaMiddleware((ctx) => ({
      userId: ctx.state?.userId ?? null,
      metadata: { path: ctx.path },
    }));

    // Simulate Koa context
    const fakeCtx = {
      state: { userId: "u_koa_123" },
      path: "/api/koa",
    };

    let capturedUserId: string | null = null;
    await middleware(fakeCtx, async () => {
      const ctx = useDrizzleAuditContext();
      capturedUserId = ctx?.userId ?? null;
    });

    expect(capturedUserId).toBe("u_koa_123");
  });

  test("context is cleaned up after middleware", async () => {
    const middleware = drizzleAuditKoaMiddleware(() => ({
      userId: "koa_temp",
    }));

    await middleware({}, async () => {});
    expect(useDrizzleAuditContext()).toBeNull();
  });
});

// Helper: start a real Node HTTP server on a random port
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
