import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { withDrizzleAudit } from "../src/with-drizzle-audit.ts";
import { drizzleAuditAction } from "../src/audit-action.ts";
import { trackAction } from "../src/track-action.ts";
import { callbackStorage } from "../src/storage/callback.ts";
import type { AuditEntry, AuditStorage } from "../src/types.ts";

// PGlite boots slowly on a loaded machine; share one instance.
vi.setConfig({ testTimeout: 60_000 });

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

let rawDb: ReturnType<typeof drizzle>;
beforeAll(async () => {
  rawDb = drizzle(new PGlite());
  await rawDb.execute(sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`);
}, 120_000);

const storageError = new Error("storage down");
const failing: AuditStorage = {
  async write() {
    throw storageError;
  },
};

let saved: AuditEntry[];
let fallback: AuditStorage;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  saved = [];
  fallback = callbackStorage((entries) => {
    saved.push(...entries);
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("fallbackStorage", () => {
  test("receives entries a failed write refused; 'warn' says so", async () => {
    const db = withDrizzleAudit(rawDb, { storage: failing, fallbackStorage: fallback });
    await db.insert(users).values({ name: "A" }).returning();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ action: "INSERT", tableName: "users" });
    expect(warn).toHaveBeenCalledWith(
      "[drizzle-audit] Failed to write audit entries (entries written to fallbackStorage):",
      storageError,
    );
  });

  test("'throw' still fails the operation, after saving to the fallback", async () => {
    const db = withDrizzleAudit(rawDb, {
      storage: failing,
      fallbackStorage: fallback,
      onError: "throw",
    });
    await expect(db.insert(users).values({ name: "A" }).returning()).rejects.toBe(storageError);
    expect(saved).toHaveLength(1);
  });

  test("a custom handler gets the original error and the entries", async () => {
    const onError = vi.fn();
    const db = withDrizzleAudit(rawDb, { storage: failing, fallbackStorage: fallback, onError });
    await db.insert(users).values({ name: "A" }).returning();
    expect(onError).toHaveBeenCalledWith(storageError, saved);
  });

  test("when the fallback fails too, onError gets an AggregateError of both", async () => {
    const fallbackError = new Error("disk full");
    const onError = vi.fn();
    const db = withDrizzleAudit(rawDb, {
      storage: failing,
      fallbackStorage: {
        async write() {
          throw fallbackError;
        },
      },
      onError,
    });
    await db.insert(users).values({ name: "A" }).returning();

    const [error, entries] = onError.mock.calls[0]!;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([storageError, fallbackError]);
    expect(entries).toHaveLength(1);
  });

  test("'ignore' still saves to the fallback, silently", async () => {
    const db = withDrizzleAudit(rawDb, {
      storage: failing,
      fallbackStorage: fallback,
      onError: "ignore",
    });
    await db.insert(users).values({ name: "A" }).returning();
    expect(saved).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("is not used when the write succeeds", async () => {
    const written: AuditEntry[] = [];
    const db = withDrizzleAudit(rawDb, {
      storage: callbackStorage((e) => {
        written.push(...e);
      }),
      fallbackStorage: fallback,
    });
    await db.insert(users).values({ name: "A" }).returning();
    expect(written).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });

  test("only gets entries that passed shouldAudit", async () => {
    const onError = vi.fn();
    const db = withDrizzleAudit(rawDb, {
      storage: failing,
      fallbackStorage: fallback,
      onError,
      shouldAudit: (ctx) => ctx.rowId !== null && Number(ctx.rowId) % 2 === 0,
    });
    const rows = await db
      .insert(users)
      .values([{ name: "A" }, { name: "B" }])
      .returning();
    const even = rows.filter((r) => r.id % 2 === 0).map((r) => String(r.id));
    expect(saved.map((e) => e.rowId)).toEqual(even);
    expect(onError.mock.calls[0]![1]).toEqual(saved);
  });

  test("batch mode: a failed flush goes to the fallback", async () => {
    const db = withDrizzleAudit(rawDb, {
      storage: failing,
      fallbackStorage: fallback,
      flushMode: "batch",
    });
    await db.insert(users).values({ name: "A" }).returning();
    await db.insert(users).values({ name: "B" }).returning();
    expect(saved).toHaveLength(0);
    await db.$audit.flush();
    expect(saved).toHaveLength(2);
    expect(db.$audit.pending).toBe(0);
  });

  test("drizzleAuditAction and trackAction use it", async () => {
    const db = withDrizzleAudit(rawDb, { storage: failing, fallbackStorage: fallback });
    await db.$audit.action({ action: "EXPORT" });
    await drizzleAuditAction({ action: "LOGIN" });
    {
      await using _t = trackAction({ action: "JOB" });
    }
    await new Promise((r) => setTimeout(r, 10)); // start entry is fire-and-forget
    expect(saved.map((e) => [e.action, e.metadata?.status])).toEqual(
      expect.arrayContaining([
        ["EXPORT", undefined],
        ["LOGIN", undefined],
        ["JOB", "started"],
        ["JOB", "completed"],
      ]),
    );
    expect(warn).toHaveBeenCalledWith(
      "[drizzle-audit] Failed to write audit action (entries written to fallbackStorage):",
      storageError,
    );
  });

  test("without fallbackStorage the behavior is unchanged", async () => {
    const db = withDrizzleAudit(rawDb, { storage: failing });
    await db.insert(users).values({ name: "A" }).returning();
    await drizzleAuditAction({ action: "LOGIN" });
    expect(warn).toHaveBeenCalledWith(
      "[drizzle-audit] Failed to write audit entries:",
      storageError,
    );
    expect(warn).toHaveBeenCalledWith(
      "[drizzle-audit] Failed to write audit action:",
      storageError,
    );
    expect(saved).toHaveLength(0);
  });
});
