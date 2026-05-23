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
});
