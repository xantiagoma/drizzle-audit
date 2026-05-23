import { test, expect, describe } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { withDrizzleAuditContext } from "../src/context.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import { sampleRate, sampleWithOverride, alwaysAudit, neverAudit } from "../src/sampling.ts";
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

describe("sampling - per-table sample shorthand", () => {
  test("sample: 0 audits nothing", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      tables: { users: { sample: 0 } },
    });

    for (let i = 0; i < 10; i++) {
      await db
        .insert(users)
        .values({ name: `User${i}`, email: `u${i}@x.com` })
        .returning();
    }

    expect(entries).toHaveLength(0);
  });

  test("sample: 1 audits everything", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      tables: { users: { sample: 1 } },
    });

    for (let i = 0; i < 5; i++) {
      await db
        .insert(users)
        .values({ name: `User${i}`, email: `u${i}@x.com` })
        .returning();
    }

    expect(entries).toHaveLength(5);
  });
});

describe("sampling - per-table shouldAudit", () => {
  test("shouldAudit function controls auditing", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      tables: {
        users: {
          shouldAudit: (ctx) => ctx.action === "DELETE",
        },
      },
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await db
      .update(users)
      .set({ name: "Bob" })
      .where(sql`id = 1`)
      .returning();
    await db
      .delete(users)
      .where(sql`id = 1`)
      .returning();

    // Only DELETE should be audited
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("DELETE");
  });

  test("shouldAudit takes priority over sample", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      tables: {
        users: {
          sample: 0, // would skip everything
          shouldAudit: () => true, // but this overrides
        },
      },
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(entries).toHaveLength(1);
  });
});

describe("sampling - global shouldAudit", () => {
  test("global shouldAudit applies to all tables", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      shouldAudit: () => false, // skip everything
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(entries).toHaveLength(0);
  });

  test("per-table overrides global", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      shouldAudit: () => false, // global: skip everything
      tables: {
        users: { shouldAudit: () => true }, // but users: always
      },
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    expect(entries).toHaveLength(1);
  });

  test("shouldAudit receives context with userId", async () => {
    let capturedCtx: any = null;
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      shouldAudit: (ctx) => {
        capturedCtx = ctx;
        return true;
      },
    });

    await withDrizzleAuditContext({ userId: "admin_1", metadata: { ip: "1.2.3.4" } }, async () => {
      await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    });

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.tableName).toBe("users");
    expect(capturedCtx.action).toBe("INSERT");
    expect(capturedCtx.userId).toBe("admin_1");
    expect(capturedCtx.metadata).toEqual({ ip: "1.2.3.4" });
  });
});

describe("sampling - async shouldAudit", () => {
  test("supports async shouldAudit function", async () => {
    const entries: AuditEntry[] = [];
    const db = withDrizzleAudit(await createTestDb(), {
      storage: callbackStorage((e) => {
        entries.push(...e);
      }),
      shouldAudit: async (ctx) => {
        // Simulate async check (KV store, feature flag, etc.)
        await new Promise((r) => setTimeout(r, 5));
        return ctx.action === "DELETE";
      },
    });

    await db.insert(users).values({ name: "Alice", email: "a@x.com" }).returning();
    await db
      .delete(users)
      .where(sql`id = 1`)
      .returning();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("DELETE");
  });
});

describe("sampling helpers", () => {
  test("sampleRate(0) never audits", () => {
    const fn = sampleRate(0);
    for (let i = 0; i < 100; i++) {
      expect(
        fn({ tableName: "t", action: "INSERT", rowId: null, userId: null, metadata: null }),
      ).toBe(false);
    }
  });

  test("sampleRate(1) always audits", () => {
    const fn = sampleRate(1);
    for (let i = 0; i < 100; i++) {
      expect(
        fn({ tableName: "t", action: "INSERT", rowId: null, userId: null, metadata: null }),
      ).toBe(true);
    }
  });

  test("sampleWithOverride always audits when override is true", () => {
    const fn = sampleWithOverride(0, (ctx) => ctx.userId === "admin");
    expect(
      fn({ tableName: "t", action: "INSERT", rowId: null, userId: "admin", metadata: null }),
    ).toBe(true);
    // Without override, rate 0 → never
    expect(
      fn({ tableName: "t", action: "INSERT", rowId: null, userId: "user", metadata: null }),
    ).toBe(false);
  });

  test("alwaysAudit returns true", () => {
    expect(
      alwaysAudit()({
        tableName: "t",
        action: "INSERT",
        rowId: null,
        userId: null,
        metadata: null,
      }),
    ).toBe(true);
  });

  test("neverAudit returns false", () => {
    expect(
      neverAudit()({ tableName: "t", action: "INSERT", rowId: null, userId: null, metadata: null }),
    ).toBe(false);
  });
});
