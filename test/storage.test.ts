import { test, expect, describe, vi } from "vitest";
import { callbackStorage } from "../src/storage/callback.ts";
import { multiStorage } from "../src/storage/multi.ts";
import { consoleStorage } from "../src/storage/console.ts";
import { httpStorage } from "../src/storage/http.ts";
import type { AuditEntry } from "../src/types.ts";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "test-id",
    tableName: "users",
    action: "INSERT",
    rowId: "1",
    changes: { name: "Alice" },
    oldData: null,
    newData: null,
    timestamp: new Date(),
    userId: null,
    metadata: null,
    ...overrides,
  };
}

describe("callbackStorage", () => {
  test("calls the provided function", async () => {
    const received: AuditEntry[][] = [];
    const storage = callbackStorage((entries) => {
      received.push(entries);
    });

    const entry = makeEntry();
    await storage.write([entry]);

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0]![0]!.action).toBe("INSERT");
  });

  test("supports async callbacks", async () => {
    let called = false;
    const storage = callbackStorage(async () => {
      await new Promise((r) => setTimeout(r, 5));
      called = true;
    });

    await storage.write([makeEntry()]);
    expect(called).toBe(true);
  });
});

describe("multiStorage", () => {
  test("sends entries to all adapters", async () => {
    const results: string[] = [];
    const adapter1 = callbackStorage(() => {
      results.push("a1");
    });
    const adapter2 = callbackStorage(() => {
      results.push("a2");
    });

    const storage = multiStorage([adapter1, adapter2]);
    await storage.write([makeEntry()]);

    expect(results).toContain("a1");
    expect(results).toContain("a2");
  });

  test("continues if one adapter fails (warn mode)", async () => {
    const results: string[] = [];
    const failing = {
      async write() {
        throw new Error("fail");
      },
    };
    const working = callbackStorage(() => {
      results.push("ok");
    });

    const storage = multiStorage([failing, working], { onError: "warn" });
    await storage.write([makeEntry()]);

    expect(results).toContain("ok");
  });

  test("throws if one adapter fails (throw mode)", async () => {
    const failing = {
      async write() {
        throw new Error("fail");
      },
    };
    const working = callbackStorage(() => {});

    const storage = multiStorage([failing, working], { onError: "throw" });

    await expect(storage.write([makeEntry()])).rejects.toThrow("fail");
  });

  test("calls flush on all adapters", async () => {
    let flushed = 0;
    const adapter = {
      async write() {},
      async flush() {
        flushed++;
      },
    };

    const storage = multiStorage([adapter, adapter]);
    await storage.flush!();

    expect(flushed).toBe(2);
  });

  test("calls close on all adapters", async () => {
    let closed = 0;
    const adapter = {
      async write() {},
      async close() {
        closed++;
      },
    };

    const storage = multiStorage([adapter, adapter]);
    await storage.close!();

    expect(closed).toBe(2);
  });

  test("custom error handler is called on failure", async () => {
    let capturedError: unknown = null;
    const failing = {
      async write() {
        throw new Error("custom fail");
      },
    };

    const storage = multiStorage([failing], {
      onError: (error) => {
        capturedError = error;
      },
    });
    await storage.write([makeEntry()]);

    expect(capturedError).toBeInstanceOf(Error);
  });

  test("ignore mode swallows errors", async () => {
    const failing = {
      async write() {
        throw new Error("ignored");
      },
    };

    const storage = multiStorage([failing], { onError: "ignore" });
    await storage.write([makeEntry()]);
    // No throw = pass
  });
});

describe("consoleStorage", () => {
  test("logs formatted entries", async () => {
    const logs: any[][] = [];
    const storage = consoleStorage({
      logger: { log: (...args: any[]) => logs.push(args) },
    });

    await storage.write([makeEntry({ action: "UPDATE", tableName: "orders", rowId: "42" })]);

    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toContain("UPDATE");
    expect(logs[0]![0]).toContain("orders");
    expect(logs[0]![0]).toContain("#42");
  });

  test("handles entries without tableName", async () => {
    const logs: any[][] = [];
    const storage = consoleStorage({
      logger: { log: (...args: any[]) => logs.push(args) },
    });

    await storage.write([makeEntry({ action: "LOGIN", tableName: null, rowId: null })]);

    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toContain("LOGIN");
  });
});

describe("httpStorage", () => {
  test("sends entries via fetch POST", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      }),
    );

    const storage = httpStorage({ url: "https://audit.test/ingest" });
    await storage.write([makeEntry()]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://audit.test/ingest");
    expect(calls[0]!.init.method).toBe("POST");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toHaveLength(1);
    expect(body[0].action).toBe("INSERT");

    vi.restoreAllMocks();
  });

  test("sends custom headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      }),
    );

    const storage = httpStorage({
      url: "https://audit.test/ingest",
      headers: { Authorization: "Bearer test-token" },
    });
    await storage.write([makeEntry()]);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");

    vi.restoreAllMocks();
  });

  test("retries on failure", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error("Network error");
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const storage = httpStorage({
      url: "https://audit.test/ingest",
      retries: 3,
    });
    await storage.write([makeEntry()]);

    expect(callCount).toBe(3); // 2 failures + 1 success

    vi.restoreAllMocks();
  });

  test("batching mode queues entries", async () => {
    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string));
        return new Response("ok", { status: 200 });
      }),
    );

    const storage = httpStorage({
      url: "https://audit.test/ingest",
      flushIntervalMs: 100,
    });

    // Write without awaiting flush
    await storage.write([makeEntry({ action: "INSERT" })]);
    await storage.write([makeEntry({ action: "UPDATE" })]);

    // No calls yet (batched)
    expect(calls).toHaveLength(0);

    // Flush manually
    await storage.flush!();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);

    await storage.close!();
    vi.restoreAllMocks();
  });
});
