import { test, expect, describe } from "vitest";
import { getTableName, getTableColumns } from "drizzle-orm";
import { pgAuditTable } from "../src/schema/pg.ts";
import { sqliteAuditTable } from "../src/schema/sqlite.ts";
import { mysqlAuditTable } from "../src/schema/mysql.ts";

const EXPECTED_COLUMNS = [
  "id",
  "tableName",
  "action",
  "rowId",
  "changes",
  "oldData",
  "newData",
  "userId",
  "metadata",
  "timestamp",
];

describe("pgAuditTable", () => {
  test("creates table with default name", () => {
    const table = pgAuditTable();
    expect(getTableName(table)).toBe("audit_log");
  });

  test("creates table with custom name", () => {
    const table = pgAuditTable("app_audit");
    expect(getTableName(table)).toBe("app_audit");
  });

  test("has all expected columns", () => {
    const table = pgAuditTable();
    const columns = getTableColumns(table);
    for (const col of EXPECTED_COLUMNS) {
      expect((columns as any)[col], `missing column: ${col}`).toBeDefined();
    }
  });

  test("default id is text (uuidv7)", () => {
    const table = pgAuditTable();
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("PgText");
  });

  test("serial id mode", () => {
    const table = pgAuditTable("audit_log", { idMode: "serial" });
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("PgBigSerial53");
  });

  test("action column is not null", () => {
    const table = pgAuditTable();
    const columns = getTableColumns(table);
    expect((columns.action as any).notNull).toBe(true);
  });

  test("timestamp column is not null with default", () => {
    const table = pgAuditTable();
    const columns = getTableColumns(table);
    expect((columns.timestamp as any).notNull).toBe(true);
    expect((columns.timestamp as any).hasDefault).toBe(true);
  });

  test("supports extra columns", () => {
    const { varchar } = require("drizzle-orm/pg-core");
    const table = pgAuditTable("audit_log", {
      extraColumns: () => ({
        tenantId: varchar("tenant_id", { length: 64 }),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).tenantId).toBeDefined();
  });
});

describe("sqliteAuditTable", () => {
  test("creates table with default name", () => {
    const table = sqliteAuditTable();
    expect(getTableName(table)).toBe("audit_log");
  });

  test("creates table with custom name", () => {
    const table = sqliteAuditTable("my_audit");
    expect(getTableName(table)).toBe("my_audit");
  });

  test("has all expected columns", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    for (const col of EXPECTED_COLUMNS) {
      expect((columns as any)[col], `missing column: ${col}`).toBeDefined();
    }
  });

  test("default id is text (uuid)", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("SQLiteText");
  });

  test("integer id mode", () => {
    const table = sqliteAuditTable("audit_log", { idMode: "serial" });
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("SQLiteInteger");
  });

  test("json columns use text mode json", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    // changes, oldData, newData, metadata should be text with json mode
    for (const col of ["changes", "oldData", "newData", "metadata"]) {
      expect((columns as any)[col].columnType).toBe("SQLiteTextJson");
    }
  });

  test("action column is not null", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    expect((columns.action as any).notNull).toBe(true);
  });

  test("supports extra columns", () => {
    const { text } = require("drizzle-orm/sqlite-core");
    const table = sqliteAuditTable("audit_log", {
      extraColumns: () => ({
        tenantId: text("tenant_id"),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).tenantId).toBeDefined();
  });
});

describe("mysqlAuditTable", () => {
  test("creates table with default name", () => {
    const table = mysqlAuditTable();
    expect(getTableName(table)).toBe("audit_log");
  });

  test("creates table with custom name", () => {
    const table = mysqlAuditTable("events_audit");
    expect(getTableName(table)).toBe("events_audit");
  });

  test("has all expected columns", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    for (const col of EXPECTED_COLUMNS) {
      expect((columns as any)[col], `missing column: ${col}`).toBeDefined();
    }
  });

  test("default id is varchar (uuid)", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("MySqlVarChar");
  });

  test("serial id mode", () => {
    const table = mysqlAuditTable("audit_log", { idMode: "serial" });
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toContain("MySqlBigInt");
  });

  test("json columns use native json type", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    for (const col of ["changes", "oldData", "newData", "metadata"]) {
      expect((columns as any)[col].columnType).toBe("MySqlJson");
    }
  });

  test("action column is not null", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    expect((columns.action as any).notNull).toBe(true);
  });

  test("timestamp column is not null with default", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    expect((columns.timestamp as any).notNull).toBe(true);
    expect((columns.timestamp as any).hasDefault).toBe(true);
  });

  test("supports extra columns", () => {
    const { varchar } = require("drizzle-orm/mysql-core");
    const table = mysqlAuditTable("audit_log", {
      extraColumns: () => ({
        tenantId: varchar("tenant_id", { length: 64 }),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).tenantId).toBeDefined();
  });
});

describe("pgAuditTable - $defaultFn", () => {
  test("extra columns factory is called", () => {
    const { varchar } = require("drizzle-orm/pg-core");
    const table = pgAuditTable("audit_log", {
      extraColumns: () => ({
        env: varchar("env", { length: 20 }),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).env).toBeDefined();
  });
});

describe("sqliteAuditTable - defaultFn closures", () => {
  test("uuid id defaultFn generates valid UUID", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    const idCol = (columns as any).id;
    // The $defaultFn should exist and return a UUID
    expect(idCol.defaultFn).toBeDefined();
    const generated = idCol.defaultFn();
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test("timestamp defaultFn generates ISO string", () => {
    const table = sqliteAuditTable();
    const columns = getTableColumns(table);
    const tsCol = columns.timestamp as any;
    expect(tsCol.defaultFn).toBeDefined();
    const generated = tsCol.defaultFn();
    expect(generated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("integer id mode does not use defaultFn", () => {
    const table = sqliteAuditTable("audit_log", { idMode: "serial" });
    const columns = getTableColumns(table);
    const idCol = (columns as any).id;
    expect(idCol.defaultFn).toBeUndefined();
  });

  test("extra columns factory is called", () => {
    const { text } = require("drizzle-orm/sqlite-core");
    const table = sqliteAuditTable("audit_log", {
      extraColumns: () => ({
        env: text("env"),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).env).toBeDefined();
  });
});

describe("mysqlAuditTable - defaultFn closures", () => {
  test("uuid id defaultFn generates valid UUID", () => {
    const table = mysqlAuditTable();
    const columns = getTableColumns(table);
    const idCol = (columns as any).id;
    expect(idCol.defaultFn).toBeDefined();
    const generated = idCol.defaultFn();
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test("serial id mode does not use defaultFn", () => {
    const table = mysqlAuditTable("audit_log", { idMode: "serial" });
    const columns = getTableColumns(table);
    const idCol = (columns as any).id;
    expect(idCol.defaultFn).toBeUndefined();
  });

  test("extra columns factory is called", () => {
    const { varchar } = require("drizzle-orm/mysql-core");
    const table = mysqlAuditTable("audit_log", {
      extraColumns: () => ({
        env: varchar("env", { length: 20 }),
      }),
    });
    const columns = getTableColumns(table);
    expect((columns as any).env).toBeDefined();
  });
});

describe("pgAuditTable - extraIndexes", () => {
  test("adds extra indexes alongside defaults", () => {
    const { index } = require("drizzle-orm/pg-core");
    const { text } = require("drizzle-orm/pg-core");
    const table = pgAuditTable("audit_log", {
      extraColumns: () => ({
        tenantId: text("tenant_id"),
      }),
      extraIndexes: (t: any) => [index("audit_tenant_idx").on(t.tenantId)],
    });
    // Table should be created without error
    expect(getTableName(table)).toBe("audit_log");
    expect((getTableColumns(table) as any).tenantId).toBeDefined();
  });
});

describe("sqliteAuditTable - extraIndexes", () => {
  test("adds extra indexes alongside defaults", () => {
    const { index } = require("drizzle-orm/sqlite-core");
    const { text } = require("drizzle-orm/sqlite-core");
    const table = sqliteAuditTable("audit_log", {
      extraColumns: () => ({
        region: text("region"),
      }),
      extraIndexes: (t: any) => [index("audit_region_idx").on(t.region)],
    });
    expect(getTableName(table)).toBe("audit_log");
    expect((getTableColumns(table) as any).region).toBeDefined();
  });
});

describe("mysqlAuditTable - extraIndexes", () => {
  test("adds extra indexes alongside defaults", () => {
    const { index, varchar } = require("drizzle-orm/mysql-core");
    const table = mysqlAuditTable("audit_log", {
      extraColumns: () => ({
        env: varchar("env", { length: 20 }),
      }),
      extraIndexes: (t: any) => [index("audit_env_idx").on(t.env)],
    });
    expect(getTableName(table)).toBe("audit_log");
    expect((getTableColumns(table) as any).env).toBeDefined();
  });
});

describe("pgAuditTable - idMode uuidv4", () => {
  test("uuidv4 uses uuid column with defaultRandom", () => {
    const table = pgAuditTable("audit_log", { idMode: "uuidv4" });
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("PgUUID");
  });
});

describe("pgAuditTable - idMode custom", () => {
  test("custom generator uses text column", () => {
    let counter = 0;
    const table = pgAuditTable("audit_log", {
      idMode: { generate: () => `custom_${++counter}` },
    });
    const columns = getTableColumns(table);
    expect((columns as any).id.columnType).toBe("PgText");
    expect((columns as any).id.defaultFn).toBeDefined();
    expect((columns as any).id.defaultFn()).toBe("custom_1");
  });
});

describe("schema consistency across dialects", () => {
  test("all dialects produce the same column names", () => {
    const pg = Object.keys(getTableColumns(pgAuditTable()));
    const sqlite = Object.keys(getTableColumns(sqliteAuditTable()));
    const mysql = Object.keys(getTableColumns(mysqlAuditTable()));

    expect(pg.sort()).toEqual(sqlite.sort());
    expect(pg.sort()).toEqual(mysql.sort());
  });

  test("all dialects default to audit_log table name", () => {
    expect(getTableName(pgAuditTable())).toBe("audit_log");
    expect(getTableName(sqliteAuditTable())).toBe("audit_log");
    expect(getTableName(mysqlAuditTable())).toBe("audit_log");
  });
});
