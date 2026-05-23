import { test, expect, describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { pgAuditTable } from "../src/schema/pg.ts";
import { drizzleTableStorage } from "../src/storage/drizzle.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import type { AuditEntry } from "../src/types.ts";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
});

const auditLog = pgAuditTable();

async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client);

  await db.execute(sql`
    CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email VARCHAR(255) NOT NULL)
  `);
  await db.execute(sql`
    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY, table_name TEXT, action VARCHAR(50) NOT NULL,
      row_id TEXT, changes JSONB, old_data JSONB, new_data JSONB,
      user_id TEXT, metadata JSONB, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  return { db, client };
}

describe("flushMode: immediate (default)", () => {
  test("writes each entry immediately", async () => {
    const writeCalls: AuditEntry[][] = [];
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage((entries) => {
        writeCalls.push([...entries]);
      }),
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(writeCalls).toHaveLength(1);

    await auditedDb.insert(users).values({ name: "Bob", email: "b@x.com" }).returning();
    expect(writeCalls).toHaveLength(2);

    // Each call has exactly 1 entry
    expect(writeCalls[0]).toHaveLength(1);
    expect(writeCalls[1]).toHaveLength(1);
  });

  test("$pendingAuditEntries is always 0 in immediate mode", async () => {
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage(() => {}),
    });

    expect(auditedDb.$pendingAuditEntries).toBe(0);
    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(auditedDb.$pendingAuditEntries).toBe(0);
  });

  test("$flushAudit is a no-op in immediate mode", async () => {
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage(() => {}),
    });

    // Should not throw
    await auditedDb.$flushAudit();
  });
});

describe("flushMode: batch", () => {
  test("buffers entries until flush is called", async () => {
    const writeCalls: AuditEntry[][] = [];
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage((entries) => {
        writeCalls.push([...entries]);
      }),
      flushMode: "batch",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(users).values({ name: "Bob", email: "b@x.com" }).returning();

    // No writes yet — buffered
    expect(writeCalls).toHaveLength(0);
    expect(auditedDb.$pendingAuditEntries).toBe(2);

    // Flush sends all at once
    await auditedDb.$flushAudit();

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toHaveLength(2);
    expect(auditedDb.$pendingAuditEntries).toBe(0);
  });

  test("flush with no pending entries is a no-op", async () => {
    const writeCalls: AuditEntry[][] = [];
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage((entries) => {
        writeCalls.push([...entries]);
      }),
      flushMode: "batch",
    });

    await auditedDb.$flushAudit();
    expect(writeCalls).toHaveLength(0);
  });

  test("multiple flushes work correctly", async () => {
    const writeCalls: AuditEntry[][] = [];
    const auditedDb = withDrizzleAudit((await createTestDb()).db, {
      storage: callbackStorage((entries) => {
        writeCalls.push([...entries]);
      }),
      flushMode: "batch",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.$flushAudit();

    await auditedDb.insert(users).values({ name: "Bob", email: "b@x.com" }).returning();
    await auditedDb.$flushAudit();

    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0]).toHaveLength(1);
    expect(writeCalls[1]).toHaveLength(1);
  });

  test("batch mode with drizzleTableStorage", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      flushMode: "batch",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(users).values({ name: "Bob", email: "b@x.com" }).returning();

    // Not written yet
    let entries = await db.select().from(auditLog);
    expect(entries).toHaveLength(0);

    // Flush
    await auditedDb.$flushAudit();

    entries = await db.select().from(auditLog);
    expect(entries).toHaveLength(2);
  });
});
