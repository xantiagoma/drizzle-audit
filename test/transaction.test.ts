import { test, expect, describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { withDrizzleAuditContext } from "../src/context.ts";
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
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email VARCHAR(255) NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT,
      action VARCHAR(50) NOT NULL,
      row_id TEXT,
      changes JSONB,
      old_data JSONB,
      new_data JSONB,
      user_id TEXT,
      metadata JSONB,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  return { db, client };
}

describe("withDrizzleAudit - transactions", () => {
  test("audits operations inside a transaction via callback storage", async () => {
    const { db } = await createTestDb();
    const entries: AuditEntry[] = [];

    const auditedDb = withDrizzleAudit(db, {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    });

    await auditedDb.transaction(async (tx: any) => {
      await tx.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
      await tx.insert(users).values({ name: "Bob", email: "b@x.com" }).returning();
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]!.action).toBe("INSERT");
    expect(entries[1]!.action).toBe("INSERT");
  });

  test("transaction with context propagates userId", async () => {
    const { db } = await createTestDb();
    const entries: AuditEntry[] = [];

    const auditedDb = withDrizzleAudit(db, {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    });

    await withDrizzleAuditContext({ userId: "tx_user" }, async () => {
      await auditedDb.transaction(async (tx: any) => {
        await tx.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
      });
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe("tx_user");
  });

  test("transaction with drizzleTableStorage writes to audit table", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, { storage });

    await auditedDb.transaction(async (tx: any) => {
      await tx.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    });

    const entries = await db.select().from(auditLog);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("INSERT");
  }, 10000);
});
