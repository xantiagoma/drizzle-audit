import { describe, expect, test, vi } from "vitest";

// Each test boots its own PGlite instance, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  sqliteTable,
  integer,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { getTableConfig as getMysqlTableConfig } from "drizzle-orm/mysql-core";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import {
  newDrizzleAuditContext,
  useDrizzleAuditContext,
  withDrizzleAuditContext,
} from "../src/context.ts";
import { drizzleAuditAction } from "../src/audit-action.ts";
import { trackAction } from "../src/track-action.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import { drizzleTableStorage } from "../src/storage/drizzle.ts";
import { pgAuditTable } from "../src/schema/pg.ts";
import { sqliteAuditTable } from "../src/schema/sqlite.ts";
import { mysqlAuditTable } from "../src/schema/mysql.ts";
import type { AuditEntry, ShouldAuditContext } from "../src/types.ts";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const PG_AUDIT_COLUMNS = `
  id TEXT PRIMARY KEY,
  table_name TEXT,
  action VARCHAR(50) NOT NULL,
  row_id TEXT,
  changes JSONB,
  old_data JSONB,
  new_data JSONB,
  user_id TEXT,
  metadata JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

async function pgDb(auditDdl?: string) {
  const db = drizzle(new PGlite());
  await db.execute(sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
  if (auditDdl) await db.execute(sql.raw(auditDdl));
  return db;
}

async function captured(fn: (db: any) => Promise<void>, options: Record<string, unknown> = {}) {
  const entries: AuditEntry[] = [];
  const db = withDrizzleAudit(await pgDb(), {
    storage: callbackStorage((e) => {
      entries.push(...e);
    }),
    ...options,
  });
  await fn(db);
  return entries;
}

describe("tenantId on entries", () => {
  test("comes from the context's tenantId for insert, update and delete", async () => {
    const entries = await captured((db) =>
      withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
        await db.insert(users).values({ name: "A" }).returning();
        await db.update(users).set({ name: "B" }).where(eq(users.id, 1)).returning();
        await db.delete(users).where(eq(users.id, 1)).returning();
      }),
    );
    expect(entries.map((e) => [e.action, e.tenantId])).toEqual([
      ["INSERT", "acme"],
      ["UPDATE", "acme"],
      ["DELETE", "acme"],
    ]);
    // tenantId is not copied into metadata
    expect(entries[0]!.metadata).toBeNull();
  });

  test("falls back to metadata.tenantId (string or number)", async () => {
    const entries = await captured(async (db) => {
      await withDrizzleAuditContext(
        { userId: "u1", metadata: { tenantId: "legacy" } },
        async () => {
          await db.insert(users).values({ name: "A" }).returning();
        },
      );
      await withDrizzleAuditContext({ userId: "u1", metadata: { tenantId: 42 } }, async () => {
        await db.insert(users).values({ name: "B" }).returning();
      });
    });
    expect(entries.map((e) => e.tenantId)).toEqual(["legacy", "42"]);
    expect(entries[0]!.metadata).toEqual({ tenantId: "legacy" });
  });

  test("tenantId wins over metadata.tenantId", async () => {
    const entries = await captured((db) =>
      withDrizzleAuditContext(
        { userId: "u1", tenantId: "new", metadata: { tenantId: "old" } },
        async () => {
          await db.insert(users).values({ name: "A" }).returning();
        },
      ),
    );
    expect(entries[0]!.tenantId).toBe("new");
  });

  test("is null without a tenant or without a context", async () => {
    const entries = await captured(async (db) => {
      await db.insert(users).values({ name: "A" }).returning();
      await withDrizzleAuditContext({ userId: "u1" }, async () => {
        await db.insert(users).values({ name: "B" }).returning();
      });
    });
    expect(entries.map((e) => e.tenantId)).toEqual([null, null]);
  });

  test("is passed to shouldAudit", async () => {
    const seen: ShouldAuditContext[] = [];
    const entries = await captured(
      (db) =>
        withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
          await db.insert(users).values({ name: "A" }).returning();
        }),
      {
        shouldAudit: (ctx: ShouldAuditContext) => {
          seen.push(ctx);
          return ctx.tenantId === "acme";
        },
      },
    );
    expect(seen[0]!.tenantId).toBe("acme");
    expect(entries).toHaveLength(1);
  });
});

describe("tenantId in context helpers", () => {
  test("withDrizzleAuditContext inherits and overrides tenantId", async () => {
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await withDrizzleAuditContext({ metadata: { step: 1 } }, async () => {
        expect(useDrizzleAuditContext()).toMatchObject({ userId: "u1", tenantId: "acme" });
      });
      await withDrizzleAuditContext({ tenantId: "globex" }, async () => {
        expect(useDrizzleAuditContext()?.tenantId).toBe("globex");
      });
      await withDrizzleAuditContext({ tenantId: null }, async () => {
        expect(useDrizzleAuditContext()?.tenantId).toBeNull();
      });
    });
  });

  test("withDrizzleAuditContext leaves tenantId off when never set", async () => {
    await withDrizzleAuditContext({ userId: "u1" }, async () => {
      expect(useDrizzleAuditContext()).toEqual({ userId: "u1", metadata: null });
    });
  });

  test("newDrizzleAuditContext does not inherit tenantId", async () => {
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await newDrizzleAuditContext({ userId: null }, async () => {
        expect(useDrizzleAuditContext()?.tenantId).toBeUndefined();
      });
    });
  });
});

describe("tenantId on custom actions", () => {
  function collect() {
    const entries: AuditEntry[] = [];
    return {
      entries,
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
    };
  }

  test("drizzleAuditAction keeps the context tenant when userId is overridden", async () => {
    const { entries, storage } = collect();
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, () =>
      drizzleAuditAction({ action: "EXPORT", userId: "admin" }, storage),
    );
    expect(entries[0]).toMatchObject({ userId: "admin", tenantId: "acme" });
  });

  test("drizzleAuditAction tenantId option overrides the context", async () => {
    const { entries, storage } = collect();
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await drizzleAuditAction({ action: "A", tenantId: "globex" }, storage);
      await drizzleAuditAction({ action: "B", tenantId: null }, storage);
    });
    await drizzleAuditAction({ action: "C", metadata: { tenantId: "meta" } }, storage);
    expect(entries.map((e) => e.tenantId)).toEqual(["globex", null, "meta"]);
  });

  test("trackAction sets tenantId on start and end entries", async () => {
    const { entries, storage } = collect();
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await using _t = trackAction({ action: "JOB" }, storage);
    });
    await (async () => {
      await using _t = trackAction({ action: "JOB2", tenantId: "globex" }, storage);
    })();
    await new Promise((r) => setTimeout(r, 0));
    expect(entries.map((e) => [e.action, e.metadata?.status, e.tenantId])).toEqual(
      expect.arrayContaining([
        ["JOB", "started", "acme"],
        ["JOB", "completed", "acme"],
        ["JOB2", "started", "globex"],
        ["JOB2", "completed", "globex"],
      ]),
    );
  });
});

describe("tenantId column", () => {
  test("schema factories add tenant_id + (tenant_id, timestamp) index only when asked", () => {
    for (const [plain, tenant, getConfig] of [
      [pgAuditTable("a"), pgAuditTable("a", { tenantId: true }), getPgTableConfig],
      [sqliteAuditTable("a"), sqliteAuditTable("a", { tenantId: true }), getSqliteTableConfig],
      [mysqlAuditTable("a"), mysqlAuditTable("a", { tenantId: true }), getMysqlTableConfig],
    ] as const) {
      const plainConfig = (getConfig as any)(plain);
      const tenantConfig = (getConfig as any)(tenant);
      expect(plainConfig.columns.map((c: any) => c.name)).not.toContain("tenant_id");
      const column = tenantConfig.columns.find((c: any) => c.name === "tenant_id");
      expect(column).toBeDefined();
      expect(column.notNull).toBe(false);
      const index = tenantConfig.indexes.find((i: any) => i.config.name === "a_tenant_id_idx");
      expect(index.config.columns.map((c: any) => c.name)).toEqual(["tenant_id", "timestamp"]);
      expect(plainConfig.indexes.some((i: any) => i.config.name === "a_tenant_id_idx")).toBe(false);
    }
  });

  test("an extraColumns tenantId replaces the built-in one", () => {
    const table = pgAuditTable("a", {
      tenantId: true,
      extraColumns: () => ({ tenantId: text("tenant_id").notNull() }),
    });
    const column = getPgTableConfig(table).columns.find((c) => c.name === "tenant_id");
    expect(column?.notNull).toBe(true);
  });

  test("PG: drizzleTableStorage writes tenant_id when the table has it", async () => {
    const auditLog = pgAuditTable("audit_log", { tenantId: true });
    const raw = await pgDb(`CREATE TABLE audit_log (${PG_AUDIT_COLUMNS}, tenant_id TEXT)`);
    const db = withDrizzleAudit(raw, {
      storage: drizzleTableStorage(auditLog, { db: raw }),
      auditTable: auditLog,
    });
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await db.insert(users).values({ name: "A" }).returning();
    });
    await db.insert(users).values({ name: "B" }).returning();
    const rows = await raw.select().from(auditLog).orderBy(auditLog.rowId);
    expect(rows.map((r: any) => r.tenantId)).toEqual(["acme", null]);
  });

  test("PG: drizzleTableStorage still writes to a table without tenant_id", async () => {
    const auditLog = pgAuditTable();
    const raw = await pgDb(`CREATE TABLE audit_log (${PG_AUDIT_COLUMNS})`);
    const db = withDrizzleAudit(raw, {
      storage: drizzleTableStorage(auditLog, { db: raw }),
      auditTable: auditLog,
      onError: "throw",
    });
    await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
      await db.insert(users).values({ name: "A" }).returning();
    });
    expect(await raw.select().from(auditLog)).toHaveLength(1);
  });

  test("SQLite: drizzleTableStorage writes tenant_id, and tolerates tables without it", async () => {
    const sqliteUsers = sqliteTable("users", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      name: sqliteText("name").notNull(),
    });
    const columns = `id TEXT PRIMARY KEY, table_name TEXT, action TEXT NOT NULL, row_id TEXT,
      changes TEXT, old_data TEXT, new_data TEXT, user_id TEXT, metadata TEXT, timestamp TEXT NOT NULL`;

    for (const withTenant of [true, false]) {
      const sqlite = new Database(":memory:");
      sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
      sqlite.exec(`CREATE TABLE audit_log (${columns}${withTenant ? ", tenant_id TEXT" : ""})`);
      const raw = drizzleSqlite(sqlite);
      const auditLog = sqliteAuditTable("audit_log", { tenantId: withTenant });
      const db = withDrizzleAudit(raw, {
        storage: drizzleTableStorage(auditLog, { db: raw }),
        auditTable: auditLog,
        onError: "throw",
      });
      await withDrizzleAuditContext({ userId: "u1", tenantId: "acme" }, async () => {
        await db.insert(sqliteUsers).values({ name: "A" }).returning();
      });
      const rows = sqlite.prepare("SELECT * FROM audit_log").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(withTenant ? "acme" : undefined);
    }
  });
});
