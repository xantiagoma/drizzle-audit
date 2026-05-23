import { test, expect, describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { withDrizzleAuditContext } from "../src/context.ts";
import { pgAuditTable } from "../src/schema/pg.ts";
import { drizzleTableStorage } from "../src/storage/drizzle.ts";
import type { AuditEntry } from "../src/types.ts";

// --- Test schema ---
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  password: text("password"),
});

const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  authorId: serial("author_id"),
});

const auditLog = pgAuditTable();

// --- Helpers ---
async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client);

  await db.execute(sql`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email VARCHAR(255) NOT NULL,
      password TEXT
    )
  `);

  await db.execute(sql`
    CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author_id SERIAL
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

  const storage = drizzleTableStorage(auditLog, { db });

  const auditedDb = withDrizzleAudit(db, { storage });

  return { db, auditedDb, client };
}

async function getAuditEntries(db: any) {
  return db.select().from(auditLog);
}

// --- Tests ---
describe("withDrizzleAudit - INSERT", () => {
  test("audits a basic insert with returning", async () => {
    const { auditedDb } = await createTestDb();

    const [user] = await auditedDb
      .insert(users)
      .values({ name: "Alice", email: "alice@test.com" })
      .returning();

    expect(user!.name).toBe("Alice");

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("INSERT");
    expect(entries[0].tableName).toBe("users");
    expect(entries[0].rowId).toBe(String(user!.id));
    expect(entries[0].userId).toBeNull();
  });

  test("audits insert with context", async () => {
    const { auditedDb } = await createTestDb();

    await withDrizzleAuditContext({ userId: "admin_1" }, async () => {
      await auditedDb.insert(users).values({ name: "Bob", email: "bob@test.com" }).returning();
    });

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe("admin_1");
  });

  test("audits insert with metadata in context", async () => {
    const { auditedDb } = await createTestDb();

    await withDrizzleAuditContext(
      { userId: "u_1", metadata: { ip: "1.2.3.4", path: "/api/users" } },
      async () => {
        await auditedDb
          .insert(users)
          .values({ name: "Charlie", email: "charlie@test.com" })
          .returning();
      },
    );

    const entries = await getAuditEntries(auditedDb);
    expect(entries[0].metadata).toEqual({ ip: "1.2.3.4", path: "/api/users" });
  });

  test("captures changes for INSERT as all new fields", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "alice@test.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    const changes = entries[0].changes as Record<string, unknown>;
    expect(changes.name).toBe("Alice");
    expect(changes.email).toBe("alice@test.com");
  });
});

describe("withDrizzleAudit - INSERT without returning", () => {
  test("audits insert without .returning()", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "alice@test.com" });

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("INSERT");
    expect(entries[0].tableName).toBe("users");
    // Without returning, we audit from the values data
    expect((entries[0].changes as any).name).toBe("Alice");
  });
});

describe("withDrizzleAudit - UPDATE without returning", () => {
  test("audits update without .returning()", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb
      .update(users)
      .set({ name: "Bob" })
      .where(sql`id = 1`);

    const entries = await getAuditEntries(auditedDb);
    const updateEntry = entries.find((e: any) => e.action === "UPDATE");
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.tableName).toBe("users");
  });
});

describe("withDrizzleAudit - DELETE without returning", () => {
  test("audits delete without .returning()", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.delete(users).where(sql`id = 1`);

    const entries = await getAuditEntries(auditedDb);
    const deleteEntry = entries.find((e: any) => e.action === "DELETE");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.tableName).toBe("users");
    // Old data should be captured via SELECT before
    expect((deleteEntry!.changes as any).name).toBe("Alice");
  });
});

describe("withDrizzleAudit - table scoping", () => {
  test("tables: array — only audits listed tables", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      tables: [users],
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(posts).values({ title: "Hello", authorId: 1 }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0].tableName).toBe("users");
  });

  test("tables: exclude — audits everything except listed", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      tables: { exclude: [posts] },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(posts).values({ title: "Hello", authorId: 1 }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0].tableName).toBe("users");
  });
});

describe("withDrizzleAudit - dataMode", () => {
  test("changes-only: populates changes, oldData/newData are null", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "changes-only",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries[0].changes).not.toBeNull();
    expect(entries[0].oldData).toBeNull();
    expect(entries[0].newData).toBeNull();
  });

  test("full-snapshots: populates oldData/newData, changes is null", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "full-snapshots",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries[0].changes).toBeNull();
    expect(entries[0].oldData).toBeNull(); // INSERT has no old data
    expect(entries[0].newData).not.toBeNull();
  });

  test("both: populates all three columns", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "both",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries[0].changes).not.toBeNull();
    expect(entries[0].newData).not.toBeNull();
  });
});

describe("withDrizzleAudit - error handling", () => {
  test("warn: logs warning but does not throw", async () => {
    const { db } = await createTestDb();

    const failingStorage = {
      async write() {
        throw new Error("Storage failed");
      },
    };

    const auditedDb = withDrizzleAudit(db, {
      storage: failingStorage,
      onError: "warn",
    });

    // Should not throw
    const [user] = await auditedDb
      .insert(users)
      .values({ name: "Alice", email: "a@x.com" })
      .returning();
    expect(user!.name).toBe("Alice");
  });

  test("throw: propagates the error", async () => {
    const { db } = await createTestDb();

    const failingStorage = {
      async write() {
        throw new Error("Storage failed");
      },
    };

    const auditedDb = withDrizzleAudit(db, {
      storage: failingStorage,
      onError: "throw",
    });

    let thrownError: Error | null = null;
    try {
      await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    } catch (e) {
      thrownError = e as Error;
    }
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toBe("Storage failed");
  });

  test("custom handler is called", async () => {
    const { db } = await createTestDb();
    let capturedError: unknown = null;
    let capturedEntries: AuditEntry[] = [];

    const failingStorage = {
      async write() {
        throw new Error("Storage failed");
      },
    };

    const auditedDb = withDrizzleAudit(db, {
      storage: failingStorage,
      onError: (error, entries) => {
        capturedError = error;
        capturedEntries = entries;
      },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedEntries).toHaveLength(1);
  });
});

describe("withDrizzleAudit - UPDATE", () => {
  test("audits an update with old and new data", async () => {
    const { auditedDb } = await createTestDb();

    // Insert a user first
    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    // Update the user
    const [updated] = await auditedDb
      .update(users)
      .set({ name: "Bob" })
      .where(sql`id = 1`)
      .returning();

    expect(updated!.name).toBe("Bob");

    const entries = await getAuditEntries(auditedDb);
    // Should have INSERT + UPDATE
    expect(entries).toHaveLength(2);

    const updateEntry = entries.find((e: any) => e.action === "UPDATE");
    expect(updateEntry).toBeDefined();
    expect(updateEntry!.tableName).toBe("users");
    expect(updateEntry!.rowId).toBe("1");
  });

  test("captures changes delta for update", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb
      .insert(users)
      .values({ name: "Alice", email: "a@x.com", password: "secret" })
      .returning();

    await auditedDb
      .update(users)
      .set({ name: "Bob" })
      .where(sql`id = 1`)
      .returning();

    const entries = await getAuditEntries(auditedDb);
    const updateEntry = entries.find((e: any) => e.action === "UPDATE");
    const changes = updateEntry!.changes as Record<string, any>;

    // Only name changed
    expect(changes.name).toEqual({ from: "Alice", to: "Bob" });
    // email and password should NOT be in changes (unchanged)
    expect(changes.email).toBeUndefined();
    expect(changes.password).toBeUndefined();
  });

  test("update with context captures userId", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    await withDrizzleAuditContext({ userId: "admin_1" }, async () => {
      await auditedDb
        .update(users)
        .set({ email: "alice@new.com" })
        .where(sql`id = 1`)
        .returning();
    });

    const entries = await getAuditEntries(auditedDb);
    const updateEntry = entries.find((e: any) => e.action === "UPDATE");
    expect(updateEntry!.userId).toBe("admin_1");
  });

  test("update with full-snapshots dataMode captures old/new data", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "full-snapshots",
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    await auditedDb
      .update(users)
      .set({ name: "Bob" })
      .where(sql`id = 1`)
      .returning();

    const entries = await getAuditEntries(auditedDb);
    const updateEntry = entries.find((e: any) => e.action === "UPDATE");

    expect(updateEntry!.oldData).toBeDefined();
    expect((updateEntry!.oldData as any).name).toBe("Alice");
    expect(updateEntry!.newData).toBeDefined();
    expect((updateEntry!.newData as any).name).toBe("Bob");
    expect(updateEntry!.changes).toBeNull();
  });
});

describe("withDrizzleAudit - UPDATE no-op", () => {
  test("skips audit when update changes nothing", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    // Update to the same value — no-op
    await auditedDb
      .update(users)
      .set({ name: "Alice" })
      .where(sql`id = 1`)
      .returning();

    const entries = await getAuditEntries(auditedDb);
    // Should only have the INSERT, no UPDATE
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("INSERT");
  });
});

describe("withDrizzleAudit - DELETE", () => {
  test("audits a delete with old data", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const [deleted] = await auditedDb
      .delete(users)
      .where(sql`id = 1`)
      .returning();

    expect(deleted!.name).toBe("Alice");

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(2); // INSERT + DELETE

    const deleteEntry = entries.find((e: any) => e.action === "DELETE");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.tableName).toBe("users");
    expect(deleteEntry!.rowId).toBe("1");
  });

  test("captures changes for delete as all old fields", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    await auditedDb
      .delete(users)
      .where(sql`id = 1`)
      .returning();

    const entries = await getAuditEntries(auditedDb);
    const deleteEntry = entries.find((e: any) => e.action === "DELETE");
    const changes = deleteEntry!.changes as Record<string, any>;

    expect(changes.name).toBe("Alice");
    expect(changes.email).toBe("a@x.com");
    expect(changes.id).toBe(1);
  });

  test("delete with context captures userId", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    await withDrizzleAuditContext({ userId: "admin_1" }, async () => {
      await auditedDb
        .delete(users)
        .where(sql`id = 1`)
        .returning();
    });

    const entries = await getAuditEntries(auditedDb);
    const deleteEntry = entries.find((e: any) => e.action === "DELETE");
    expect(deleteEntry!.userId).toBe("admin_1");
  });

  test("delete excluded table is not audited", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      tables: { exclude: [users] },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb
      .delete(users)
      .where(sql`id = 1`)
      .returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(0);
  });
});

describe("withDrizzleAudit - transforms", () => {
  test("global transform is applied to all entries", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      transform: (entry) => ({
        ...entry,
        metadata: { ...entry.metadata, env: "test" },
      }),
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect((entries[0].metadata as any).env).toBe("test");
  });

  test("per-table transforms are applied", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });
    const { redact } = await import("../src/transforms/redact.ts");

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "both",
      tables: {
        users: {
          transforms: [redact("password")],
        },
      },
    });

    await auditedDb
      .insert(users)
      .values({ name: "Alice", email: "a@x.com", password: "secret123" })
      .returning();

    const entries = await getAuditEntries(auditedDb);
    expect((entries[0].newData as any).password).toBe("[REDACTED]");
    expect((entries[0].newData as any).name).toBe("Alice");
    // changes should also be redacted
    expect((entries[0].changes as any).password).toBe("[REDACTED]");
  });
});

describe("withDrizzleAudit - audit table auto-exclusion", () => {
  test("auditTable option prevents infinite recursion", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      auditTable: auditLog,
    });

    // Insert a user — should be audited
    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tableName).toBe("users");

    // The audit_log insert itself was NOT audited (no infinite recursion)
    // If it were audited, we'd have 2+ entries (or a stack overflow)
  });
});

describe("withDrizzleAudit - per-table config (record)", () => {
  test("record config with true audits with defaults", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      tables: {
        users: true,
        posts: true,
      },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(posts).values({ title: "Hello", authorId: 1 }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(2);
  });

  test("record config excludes unlisted tables", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      tables: {
        users: true,
        // posts not listed — should not be audited
      },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await auditedDb.insert(posts).values({ title: "Hello", authorId: 1 }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tableName).toBe("users");
  });

  test("per-table dataMode overrides global", async () => {
    const { db } = await createTestDb();
    const storage = drizzleTableStorage(auditLog, { db });

    const auditedDb = withDrizzleAudit(db, {
      storage,
      dataMode: "changes-only",
      tables: {
        users: { dataMode: "full-snapshots" },
      },
    });

    await auditedDb.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();

    const entries = await getAuditEntries(auditedDb);
    expect(entries[0]!.changes).toBeNull();
    expect(entries[0]!.newData).not.toBeNull();
  });
});

describe("withDrizzleAudit - transactions", () => {
  test("audits operations inside a transaction", async () => {
    const { auditedDb } = await createTestDb();

    await auditedDb.transaction(async (tx: any) => {
      await tx.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
      await tx.insert(posts).values({ title: "Hello", authorId: 1 }).returning();
    });

    const entries = await getAuditEntries(auditedDb);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.tableName).toBe("users");
    expect(entries[1]!.tableName).toBe("posts");
  });
});

describe("consoleStorage", () => {
  test("logs entries to provided logger", async () => {
    const { consoleStorage } = await import("../src/storage/console.ts");
    const logs: any[] = [];
    const storage = consoleStorage({ logger: { log: (...args: any[]) => logs.push(args) } });

    await storage.write([
      {
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
      },
    ]);

    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toContain("INSERT");
    expect(logs[0][0]).toContain("users");
  });
});
