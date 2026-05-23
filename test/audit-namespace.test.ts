import { test, expect, describe, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import type { AuditEntry } from "../src/types.ts";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
});

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client);
  await db.execute(
    sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email VARCHAR(255) NOT NULL)`,
  );
  return db;
}

describe("db.$audit namespace", () => {
  let entries: AuditEntry[];
  const storage = callbackStorage((e) => {
    entries.push(...e);
  });

  beforeEach(() => {
    entries = [];
  });

  test("$audit is accessible on wrapped db", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });
    expect(db.$audit).toBeDefined();
    expect(typeof db.$audit.flush).toBe("function");
    expect(typeof db.$audit.action).toBe("function");
    expect(typeof db.$audit.track).toBe("function");
    expect(typeof db.$audit.withContext).toBe("function");
    expect(typeof db.$audit.context).toBe("function");
    expect(typeof db.$audit.addMetadata).toBe("function");
    expect(typeof db.$audit.pending).toBe("number");
  });

  test("$audit.action writes a custom entry", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.action({
      action: "LOGIN",
      userId: "u_1",
      metadata: { ip: "1.2.3.4" },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("LOGIN");
    expect(entries[0]!.userId).toBe("u_1");
  });

  test("$audit.track creates start+end entries", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    {
      await using _t = db.$audit.track({ action: "PROCESS" });
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(entries).toHaveLength(2);
    const statuses = entries.map((e) => (e.metadata as any)?.status);
    expect(statuses).toContain("started");
    expect(statuses).toContain("completed");
  });

  test("$audit.withContext sets context for the scope", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.withContext({ userId: "ctx_user" }, async () => {
      await db.$audit.action({ action: "IN_CONTEXT" });
    });

    expect(entries[0]!.userId).toBe("ctx_user");
  });

  test("$audit.context returns current context", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    expect(db.$audit.context()).toBeNull();

    await db.$audit.withContext({ userId: "u_check" }, async () => {
      const ctx = db.$audit.context();
      expect(ctx?.userId).toBe("u_check");
    });
  });

  test("$audit.addMetadata merges into context", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.withContext({ userId: "u_1", metadata: { ip: "1.2.3.4" } }, async () => {
      db.$audit.addMetadata({ requestId: "req_1" });
      await db.$audit.action({ action: "WITH_META" });
    });

    expect((entries[0]!.metadata as any).ip).toBe("1.2.3.4");
    expect((entries[0]!.metadata as any).requestId).toBe("req_1");
  });

  test("$audit.flush and $audit.pending work in batch mode", async () => {
    const db = withDrizzleAudit(await createTestDb(), {
      storage,
      flushMode: "batch",
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    expect(db.$audit.pending).toBe(1);
    expect(entries).toHaveLength(0);

    await db.$audit.flush();

    expect(db.$audit.pending).toBe(0);
    expect(entries).toHaveLength(1);
  });

  test("legacy $flushAudit and $pendingAuditEntries still work", async () => {
    const db = withDrizzleAudit(await createTestDb(), {
      storage,
      flushMode: "batch",
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    expect(db.$pendingAuditEntries).toBe(1);
    await db.$flushAudit();
    expect(db.$pendingAuditEntries).toBe(0);
    expect(entries).toHaveLength(1);
  });

  test("$audit.newContext replaces context entirely", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.withContext({ userId: "outer", metadata: { ip: "1.2.3.4" } }, async () => {
      await db.$audit.newContext({ userId: null, metadata: { trigger: "system" } }, async () => {
        await db.$audit.action({ action: "SYSTEM_OP" });
      });
    });

    expect(entries[0]!.userId).toBeNull();
    expect((entries[0]!.metadata as any).trigger).toBe("system");
    expect((entries[0]!.metadata as any).ip).toBeUndefined(); // NOT inherited
  });

  test("$audit.withContext merges with existing context", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.withContext({ userId: "admin", metadata: { ip: "1.2.3.4" } }, async () => {
      await db.$audit.withContext({ metadata: { operation: "edit" } }, async () => {
        await db.$audit.action({ action: "NESTED_OP" });
      });
    });

    expect(entries[0]!.userId).toBe("admin"); // inherited
    expect((entries[0]!.metadata as any).ip).toBe("1.2.3.4"); // inherited
    expect((entries[0]!.metadata as any).operation).toBe("edit"); // merged
  });

  test("complex nested context with track, action, withContext, newContext", async () => {
    const db = withDrizzleAudit(await createTestDb(), { storage });

    await db.$audit.withContext({ userId: "admin_1", metadata: { ip: "10.0.0.1" } }, async () => {
      // Add metadata to the current context
      db.$audit.addMetadata({ function: "something" });

      // Track the outer operation
      {
        using _outerTrack = db.$audit.track({
          action: "EDIT",
          metadata: { s: 6 },
        });

        // Wait for the START entry to write
        await new Promise((r) => setTimeout(r, 10));

        // Nested withContext — merges userId + metadata
        await db.$audit.withContext({ userId: null, metadata: { now: "2026-01-01" } }, async () => {
          // userId is now null (overridden), metadata merged with outer
          {
            await using _innerTrack = db.$audit.track({
              action: "OTHER",
              metadata: { extra_data: { more: "data" } },
            });

            await new Promise((r) => setTimeout(r, 10));

            await db.$audit.action({
              action: "IN_PROGRESS_SOMETHING",
              metadata: { r: 5 },
            });
          }
          // Inner track END written here (await using)
        });

        // Back to outer context after withContext exits
      }
      // Outer track END written here (using — fire-and-forget)
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have 6 entries:
    // 1. EDIT START
    // 2. OTHER START
    // 3. IN_PROGRESS_SOMETHING
    // 4. OTHER END (completed)
    // 5. EDIT END (completed)
    expect(entries.length).toBeGreaterThanOrEqual(5);

    // EDIT START should have admin_1 userId
    const editStart = entries.find(
      (e) => e.action === "EDIT" && (e.metadata as any)?.status === "started",
    );
    expect(editStart).toBeDefined();
    expect(editStart!.userId).toBe("admin_1");
    expect((editStart!.metadata as any).ip).toBe("10.0.0.1");
    expect((editStart!.metadata as any).function).toBe("something");
    expect((editStart!.metadata as any).s).toBe(6);

    // OTHER START should have null userId (overridden by withContext)
    const otherStart = entries.find(
      (e) => e.action === "OTHER" && (e.metadata as any)?.status === "started",
    );
    expect(otherStart).toBeDefined();
    expect(otherStart!.userId).toBeNull();
    expect((otherStart!.metadata as any).now).toBe("2026-01-01"); // from withContext
    expect((otherStart!.metadata as any).ip).toBe("10.0.0.1"); // inherited from outer
    expect((otherStart!.metadata as any).function).toBe("something"); // inherited

    // IN_PROGRESS_SOMETHING should have null userId
    const inProgress = entries.find((e) => e.action === "IN_PROGRESS_SOMETHING");
    expect(inProgress).toBeDefined();
    expect(inProgress!.userId).toBeNull();
    expect((inProgress!.metadata as any).r).toBe(5);

    // OTHER END should be completed with duration
    const otherEnd = entries.find(
      (e) => e.action === "OTHER" && (e.metadata as any)?.status === "completed",
    );
    expect(otherEnd).toBeDefined();
    expect((otherEnd!.metadata as any).duration).toBeTypeOf("number");

    // EDIT END should be completed with admin_1 userId (back to outer context)
    const editEnd = entries.find(
      (e) => e.action === "EDIT" && (e.metadata as any)?.status === "completed",
    );
    expect(editEnd).toBeDefined();
    expect(editEnd!.userId).toBe("admin_1");
    expect((editEnd!.metadata as any).duration).toBeTypeOf("number");
  });
});
