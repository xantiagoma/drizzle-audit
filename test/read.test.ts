import { describe, expect, test, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { toAuditEntry } from "../src/index.ts";
import { toDate } from "../src/read.ts";
import { drizzleTableStorage } from "../src/storage/drizzle.ts";
import { pgAuditTable } from "../src/schema/pg.ts";
import { sqliteAuditTable } from "../src/schema/sqlite.ts";
import { mysqlAuditTable } from "../src/schema/mysql.ts";
import type { AuditEntry } from "../src/types.ts";

vi.setConfig({ testTimeout: 60_000 });

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "e1",
  tableName: "users",
  action: "UPDATE",
  rowId: "7",
  changes: { name: { from: "A", to: "B" } },
  oldData: { id: 7, name: "A" },
  newData: { id: 7, name: "B" },
  timestamp: new Date(),
  userId: "u1",
  tenantId: "acme",
  metadata: { ip: "1.2.3.4" },
  ...overrides,
});

function expectNormalized(result: AuditEntry, before: number) {
  expect(result.timestamp).toBeInstanceOf(Date);
  // Written by the DB clock just now (allow some skew/precision loss)
  expect(Math.abs(result.timestamp.getTime() - before)).toBeLessThan(60_000);
  expect(typeof result.id).toBe("string");
  expect(result).toMatchObject({
    tableName: "users",
    action: "UPDATE",
    rowId: "7",
    changes: { name: { from: "A", to: "B" } },
    userId: "u1",
    tenantId: "acme",
    metadata: { ip: "1.2.3.4" },
  });
}

describe("toAuditEntry per driver", () => {
  test("PostgreSQL (PGlite): drizzle select and raw SQL rows", async () => {
    const auditLog = pgAuditTable("audit_log", { tenantId: true });
    const db = drizzle(new PGlite());
    await db.execute(sql`
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, table_name TEXT, action VARCHAR(50) NOT NULL, row_id TEXT,
        changes JSONB, old_data JSONB, new_data JSONB, user_id TEXT, tenant_id TEXT,
        metadata JSONB, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const before = Date.now();
    await drizzleTableStorage(auditLog, { db }).write([entry({ oldData: null, newData: null })]);

    const [selected] = await db.select().from(auditLog);
    const fromSelect = toAuditEntry(selected!);
    expectNormalized(fromSelect, before);

    const raw = await db.execute(sql`SELECT * FROM audit_log`);
    const fromRaw = toAuditEntry((raw as any).rows[0]);
    expectNormalized(fromRaw, before);
    expect(fromRaw.timestamp.getTime()).toBe(fromSelect.timestamp.getTime());

    // Postgres text output (what drivers return with date parsing disabled)
    const asText = await db.execute(
      sql`SELECT id, action, timestamp::text AS timestamp FROM audit_log`,
    );
    const textTimestamp = (asText as any).rows[0].timestamp as string;
    expect(typeof textTimestamp).toBe("string");
    expect(toAuditEntry((asText as any).rows[0]).timestamp.getTime()).toBe(
      fromSelect.timestamp.getTime(),
    );
  });

  test("SQLite (better-sqlite3): string timestamps and JSON text become Date and objects", async () => {
    const auditLog = sqliteAuditTable("audit_log", { tenantId: true });
    const sqlite = new Database(":memory:");
    sqlite.exec(`CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, table_name TEXT, action TEXT NOT NULL, row_id TEXT, changes TEXT,
      old_data TEXT, new_data TEXT, user_id TEXT, tenant_id TEXT, metadata TEXT, timestamp TEXT NOT NULL
    )`);
    const db = drizzleSqlite(sqlite);
    const before = Date.now();
    await drizzleTableStorage(auditLog, { db }).write([entry({ oldData: null, newData: null })]);

    const [selected] = db.select().from(auditLog).all();
    expect(typeof selected!.timestamp).toBe("string"); // what the driver returns
    const fromSelect = toAuditEntry(selected!);
    expectNormalized(fromSelect, before);

    const raw = sqlite.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;
    expect(typeof raw.changes).toBe("string"); // unparsed JSON text
    const fromRaw = toAuditEntry(raw);
    expectNormalized(fromRaw, before);
    expect(fromRaw.timestamp.getTime()).toBe(fromSelect.timestamp.getTime());

    // A table filled with SQLite's CURRENT_TIMESTAMP (UTC, no zone)
    expect(toAuditEntry({ ...raw, timestamp: "2026-11-20 21:40:50" }).timestamp.toISOString()).toBe(
      "2026-11-20T21:40:50.000Z",
    );
  });

  test("MySQL (mysql2 shapes): Date, dateStrings and JSON-as-text rows", () => {
    const auditLog = mysqlAuditTable("audit_log", { tenantId: true });
    // drizzle's mysql2 driver reads timestamps as strings and maps them through the column
    const mapped = (auditLog.timestamp as any).mapFromDriverValue("2026-11-20 21:40:50.123");
    const base = {
      id: "e1",
      tableName: "users",
      action: "UPDATE",
      rowId: "7",
      changes: { name: { from: "A", to: "B" } },
      oldData: null,
      newData: null,
      userId: "u1",
      tenantId: "acme",
      metadata: { ip: "1.2.3.4" },
    };
    const expected = "2026-11-20T21:40:50.123Z";

    expect(toAuditEntry({ ...base, timestamp: mapped }).timestamp.toISOString()).toBe(expected);
    // raw mysql2 with `dateStrings: true` (UTC session)
    expect(
      toAuditEntry({ ...base, timestamp: "2026-11-20 21:40:50.123" }).timestamp.toISOString(),
    ).toBe(expected);
    // raw mysql2 default: Date
    expect(toAuditEntry({ ...base, timestamp: new Date(expected) }).timestamp.toISOString()).toBe(
      expected,
    );
    // JSON columns returned as text (e.g. serverless MySQL drivers), snake_case keys, serial id
    const raw = toAuditEntry({
      id: 12,
      table_name: "users",
      action: "UPDATE",
      row_id: 7,
      changes: JSON.stringify(base.changes),
      old_data: null,
      new_data: null,
      user_id: "u1",
      tenant_id: "acme",
      metadata: JSON.stringify(base.metadata),
      timestamp: "2026-11-20 21:40:50.123",
    });
    expect(raw).toEqual({ ...base, id: "12", timestamp: new Date(expected) });
  });
});

describe("toAuditEntry", () => {
  test("reads the tenant from metadata.tenantId for rows written before tenantId existed", () => {
    const row = { id: "1", action: "INSERT", timestamp: new Date(), metadata: { tenantId: "old" } };
    expect(toAuditEntry(row).tenantId).toBe("old");
    expect(toAuditEntry({ ...row, tenantId: "new" }).tenantId).toBe("new");
    expect(toAuditEntry({ ...row, metadata: null }).tenantId).toBeNull();
  });

  test("defaults missing nullable fields to null", () => {
    expect(toAuditEntry({ id: "1", action: "LOGIN", timestamp: 0 })).toEqual({
      id: "1",
      tableName: null,
      action: "LOGIN",
      rowId: null,
      changes: null,
      oldData: null,
      newData: null,
      timestamp: new Date(0),
      userId: null,
      tenantId: null,
      metadata: null,
    });
  });

  test("does not share the Date instance with the row", () => {
    const row = { id: "1", action: "A", timestamp: new Date(1000) };
    const result = toAuditEntry(row);
    expect(result.timestamp).not.toBe(row.timestamp);
    expect(result.timestamp.getTime()).toBe(1000);
  });

  test("throws on an invalid timestamp or invalid JSON", () => {
    expect(() => toAuditEntry({ id: "1", action: "A", timestamp: "not a date" })).toThrow(
      /invalid timestamp/,
    );
    expect(() => toAuditEntry({ id: "1", action: "A" })).toThrow(/invalid timestamp/);
    expect(() =>
      toAuditEntry({ id: "1", action: "A", timestamp: new Date(), changes: "{nope" }),
    ).toThrow(/changes is not valid JSON/);
  });
});

describe("toDate", () => {
  test.each([
    ["2026-11-20T21:40:50.123Z", "2026-11-20T21:40:50.123Z"],
    ["2026-11-20T21:40:50.123+02:00", "2026-11-20T19:40:50.123Z"],
    ["2026-11-20 21:40:50.123+00", "2026-11-20T21:40:50.123Z"],
    ["2026-11-20 21:40:50.123456+05:30", "2026-11-20T16:10:50.123Z"],
    ["2026-11-20 21:40:50-0300", "2026-11-21T00:40:50.000Z"],
    ["2026-11-20 21:40:50", "2026-11-20T21:40:50.000Z"],
    ["2026-11-20 21:40", "2026-11-20T21:40:00.000Z"],
    [1_763_674_850, "2025-11-20T21:40:50.000Z"], // epoch seconds (SQLite unixepoch())
    [1_763_674_850_123, "2025-11-20T21:40:50.123Z"], // epoch milliseconds
    [1_763_674_850_123n, "2025-11-20T21:40:50.123Z"],
  ])("%s", (input, iso) => {
    expect(toDate(input).toISOString()).toBe(iso);
  });
});
