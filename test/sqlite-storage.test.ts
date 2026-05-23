import { test, expect, describe } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import { sqliteAuditTable } from "../src/schema/sqlite.ts";
import type { AuditEntry } from "../src/types.ts";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

const auditLog = sqliteAuditTable();

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);

  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      table_name TEXT,
      action TEXT NOT NULL,
      row_id TEXT,
      changes TEXT,
      old_data TEXT,
      new_data TEXT,
      user_id TEXT,
      metadata TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  return { db, sqlite };
}

describe("SQLite drizzleTableStorage — Date fix", () => {
  test("drizzleTableStorage writes to SQLite without Date binding error", () => {
    const { db, sqlite } = createTestDb();

    // Manually write an entry — this is what the storage adapter does
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      tableName: "users",
      action: "INSERT",
      rowId: "1",
      changes: { name: "Alice" },
      oldData: null,
      newData: null,
      timestamp: new Date(), // This would have failed before the fix
      userId: null,
      metadata: null,
    };

    // Should not throw "Binding expected string" error
    expect(() => {
      db.insert(auditLog)
        .values({
          tableName: entry.tableName,
          action: entry.action,
          rowId: entry.rowId,
          changes: entry.changes,
          oldData: entry.oldData,
          newData: entry.newData,
          userId: entry.userId,
          metadata: entry.metadata,
          // NOT passing timestamp — let $defaultFn handle it
        })
        .run();
    }).not.toThrow();

    const rows = sqlite.prepare("SELECT * FROM audit_log").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("INSERT");
    expect(typeof rows[0].timestamp).toBe("string");
  });
});

describe("SQLite with callbackStorage (sync interception)", () => {
  test("INSERT is audited via callbackStorage", () => {
    const { db } = createTestDb();
    const entries: AuditEntry[] = [];

    const auditedDb = withDrizzleAudit(db, {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    });

    auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).run();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("INSERT");
    expect(entries[0]!.tableName).toBe("users");
  });

  test("UPDATE is audited via callbackStorage", () => {
    const { db } = createTestDb();
    const entries: AuditEntry[] = [];

    const auditedDb = withDrizzleAudit(db, {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    });

    auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).run();
    auditedDb.update(users).set({ name: "Bob" }).where(eq(users.id, 1)).run();

    const updateEntry = entries.find((e) => e.action === "UPDATE");
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.tableName).toBe("users");
  });

  test("DELETE is audited via callbackStorage", () => {
    const { db } = createTestDb();
    const entries: AuditEntry[] = [];

    const auditedDb = withDrizzleAudit(db, {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    });

    auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).run();
    auditedDb.delete(users).where(eq(users.id, 1)).run();

    const deleteEntry = entries.find((e) => e.action === "DELETE");
    expect(deleteEntry).toBeDefined();
  });
});
