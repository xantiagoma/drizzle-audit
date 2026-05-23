import { test, expect, describe, beforeEach } from "vitest";
import { drizzleAuditAction } from "../src/audit-action.ts";
import { _setGlobalStorage } from "../src/audit-action-internal.ts";
import { withDrizzleAuditContext } from "../src/context.ts";
import type { AuditEntry } from "../src/types.ts";

describe("drizzleAuditAction", () => {
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

  test("writes a custom action", async () => {
    await drizzleAuditAction({
      action: "LOGIN_SUCCESS",
      userId: "u_123",
      metadata: { ip: "1.2.3.4" },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("LOGIN_SUCCESS");
    expect(entries[0]!.userId).toBe("u_123");
    expect(entries[0]!.metadata).toEqual({ ip: "1.2.3.4" });
    expect(entries[0]!.tableName).toBeNull();
  });

  test("writes with table and rowId", async () => {
    await drizzleAuditAction({
      action: "VIEW_PII",
      tableName: "users",
      rowId: "42",
      metadata: { fields: ["email", "phone"] },
    });

    expect(entries[0]!.tableName).toBe("users");
    expect(entries[0]!.rowId).toBe("42");
  });

  test("picks up context from ALS", async () => {
    await withDrizzleAuditContext(
      { userId: "als_user", metadata: { requestId: "req_1" } },
      async () => {
        await drizzleAuditAction({
          action: "EXPORT_DATA",
          metadata: { format: "csv" },
        });
      },
    );

    expect(entries[0]!.userId).toBe("als_user");
    expect(entries[0]!.metadata).toEqual({ requestId: "req_1", format: "csv" });
  });

  test("explicit userId overrides ALS context", async () => {
    await withDrizzleAuditContext({ userId: "als_user" }, async () => {
      await drizzleAuditAction({
        action: "SYSTEM_EVENT",
        userId: "system",
      });
    });

    expect(entries[0]!.userId).toBe("system");
  });

  test("can be fire-and-forget (no await)", async () => {
    // Don't await — just fire
    drizzleAuditAction({
      action: "FIRE_AND_FORGET",
    });

    // Wait a tick for the promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("FIRE_AND_FORGET");
  });

  test("works with explicit storage", async () => {
    const customEntries: AuditEntry[] = [];
    const customStorage = {
      async write(e: AuditEntry[]) {
        customEntries.push(...e);
      },
    };

    await drizzleAuditAction({ action: "CUSTOM_STORAGE_TEST" }, customStorage);

    expect(customEntries).toHaveLength(1);
    expect(entries).toHaveLength(0); // global storage not used
  });

  test("warns when no storage configured", async () => {
    _setGlobalStorage(null as any);
    // Should not throw, just warn
    await drizzleAuditAction({ action: "NO_STORAGE" });
  });

  test("error handler throw mode propagates error", async () => {
    const failingStorage = {
      async write() {
        throw new Error("action write failed");
      },
    };
    _setGlobalStorage(failingStorage, "throw");

    await expect(drizzleAuditAction({ action: "FAIL" })).rejects.toThrow("action write failed");
  });

  test("error handler ignore mode swallows error", async () => {
    const failingStorage = {
      async write() {
        throw new Error("ignored");
      },
    };
    _setGlobalStorage(failingStorage, "ignore");

    await drizzleAuditAction({ action: "IGNORED_FAIL" });
    // No throw = pass
  });

  test("error handler warn mode logs warning", async () => {
    const failingStorage = {
      async write() {
        throw new Error("warned");
      },
    };
    _setGlobalStorage(failingStorage, "warn");

    await drizzleAuditAction({ action: "WARNED_FAIL" });
    // No throw = pass
  });

  test("custom error handler is called", async () => {
    let capturedError: unknown = null;
    const failingStorage = {
      async write() {
        throw new Error("custom handler");
      },
    };
    _setGlobalStorage(failingStorage, (error) => {
      capturedError = error;
    });

    await drizzleAuditAction({ action: "CUSTOM_ERR" });

    expect(capturedError).toBeInstanceOf(Error);
  });

  test("writes without metadata when none provided", async () => {
    await drizzleAuditAction({ action: "NO_META" });
    expect(entries[0]!.metadata).toBeNull();
  });
});
