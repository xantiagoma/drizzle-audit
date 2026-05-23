import { test, expect, describe, beforeEach } from "vitest";
import { trackAction } from "../src/track-action.ts";
import { _setGlobalStorage } from "../src/audit-action-internal.ts";
import { withDrizzleAuditContext } from "../src/context.ts";
import type { AuditEntry } from "../src/types.ts";

describe("trackAction", () => {
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

  test("writes START entry immediately", async () => {
    const tracker = trackAction({ action: "PROCESS_ORDER" });
    // Wait a tick for the fire-and-forget START to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("PROCESS_ORDER");
    expect((entries[0]!.metadata as any).status).toBe("started");

    // Clean up
    tracker[Symbol.dispose]();
  });

  test("Symbol.dispose writes END entry with completed status", async () => {
    {
      using _tracker = trackAction({ action: "SYNC_DATA" });
      await new Promise((r) => setTimeout(r, 10));
    }
    // Wait for fire-and-forget END
    await new Promise((r) => setTimeout(r, 10));

    expect(entries).toHaveLength(2);
    const endEntry = entries.find((e) => (e.metadata as any)?.status === "completed");
    expect(endEntry).toBeDefined();
    expect((endEntry!.metadata as any).duration).toBeTypeOf("number");
  });

  test("Symbol.asyncDispose writes END entry and awaits", async () => {
    {
      await using _tracker = trackAction({ action: "GENERATE_REPORT" });
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(entries).toHaveLength(2);
    const endEntry = entries.find((e) => (e.metadata as any)?.status === "completed");
    expect(endEntry).toBeDefined();
  });

  test("addMetadata accumulates data for END entry", async () => {
    {
      await using tracker = trackAction({
        action: "BULK_IMPORT",
        metadata: { source: "csv" },
      });
      await new Promise((r) => setTimeout(r, 5));
      tracker.addMetadata({ rowCount: 1500 });
      tracker.addMetadata({ errors: 3 });
    }

    const endEntry = entries.find((e) => (e.metadata as any)?.status === "completed");
    expect(endEntry).toBeDefined();
    expect((endEntry!.metadata as any).source).toBe("csv");
    expect((endEntry!.metadata as any).rowCount).toBe(1500);
    expect((endEntry!.metadata as any).errors).toBe(3);
    expect((endEntry!.metadata as any).duration).toBeTypeOf("number");
  });

  test("duration is tracked", async () => {
    {
      await using _tracker = trackAction({ action: "SLOW_OP" });
      await new Promise((r) => setTimeout(r, 50));
    }

    const endEntry = entries.find((e) => (e.metadata as any)?.status === "completed");
    expect((endEntry!.metadata as any).duration).toBeGreaterThanOrEqual(40);
  });

  test("picks up context from ALS", async () => {
    await withDrizzleAuditContext({ userId: "u_123" }, async () => {
      {
        await using _tracker = trackAction({ action: "CTX_TEST" });
      }
    });

    expect(entries.every((e) => e.userId === "u_123")).toBe(true);
  });

  test("explicit userId overrides ALS", async () => {
    await withDrizzleAuditContext({ userId: "als_user" }, async () => {
      {
        await using _tracker = trackAction({ action: "OVERRIDE", userId: "explicit" });
      }
    });

    expect(entries.every((e) => e.userId === "explicit")).toBe(true);
  });

  test("works with explicit storage", async () => {
    const customEntries: AuditEntry[] = [];
    const customStorage = {
      async write(e: AuditEntry[]) {
        customEntries.push(...e);
      },
    };

    {
      await using _tracker = trackAction({ action: "CUSTOM" }, customStorage);
    }

    expect(customEntries).toHaveLength(2);
    expect(entries).toHaveLength(0);
  });

  test("handles no storage gracefully", async () => {
    _setGlobalStorage(null as any);

    {
      using _tracker = trackAction({ action: "NO_STORAGE" });
    }
    // No throw = pass
  });

  test("Symbol.dispose handles write error gracefully", async () => {
    _setGlobalStorage({
      async write() {
        throw new Error("dispose write failed");
      },
    });

    {
      using _tracker = trackAction({ action: "FAIL_DISPOSE" });
    }
    // Wait for fire-and-forget error handling
    await new Promise((r) => setTimeout(r, 20));
    // No throw = pass (warn mode)
  });

  test("Symbol.asyncDispose handles write error gracefully", async () => {
    let writeCount = 0;
    _setGlobalStorage({
      async write() {
        writeCount++;
        if (writeCount > 1) throw new Error("async dispose write failed");
      },
    });

    {
      await using _tracker = trackAction({ action: "FAIL_ASYNC_DISPOSE" });
      await new Promise((r) => setTimeout(r, 10));
    }
    // No throw = pass (warn mode)
  });

  test("tracks tableName and rowId", async () => {
    {
      await using _tracker = trackAction({
        action: "TRACK_WITH_TABLE",
        tableName: "orders",
        rowId: "ord_123",
      });
    }

    expect(entries.every((e) => e.tableName === "orders")).toBe(true);
    expect(entries.every((e) => e.rowId === "ord_123")).toBe(true);
  });
});
