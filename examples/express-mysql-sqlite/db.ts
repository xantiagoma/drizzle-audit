import { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { createDB } from "mysql-memory-server";
import { sql } from "drizzle-orm";
import { withDrizzleAudit } from "../../src/index.ts";
import { callbackStorage } from "../../src/storage/callback.ts";
import { mask, redact } from "../../src/transforms/index.ts";
import * as schema from "./schema.ts";

// --- SQLite audit database (bun:sqlite, in-memory) ---
const sqliteDb = new Database(":memory:");
const auditDb = drizzleSqlite(sqliteDb);

sqliteDb.run(`
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
sqliteDb.run("CREATE INDEX audit_log_table_name_idx ON audit_log(table_name)");
sqliteDb.run("CREATE INDEX audit_log_action_idx ON audit_log(action)");
sqliteDb.run("CREATE INDEX audit_log_user_id_idx ON audit_log(user_id)");
sqliteDb.run("CREATE INDEX audit_log_timestamp_idx ON audit_log(timestamp)");

// --- MySQL app database (in-memory via mysql-memory-server) ---
console.log("Starting MySQL...");
const mysqlServer = await createDB();
console.log(`MySQL running on port ${mysqlServer.port} (db: ${mysqlServer.dbName})`);

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: mysqlServer.port,
  user: mysqlServer.username,
  database: mysqlServer.dbName,
  password: "",
});

const rawDb = drizzleMysql(pool);

// Create users table
await rawDb.execute(sql`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    \`role\` VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Seed
await rawDb.insert(schema.users).values([
  { name: "Alice Johnson", email: "alice@example.com", role: "admin" },
  { name: "Bob Smith", email: "bob@example.com", role: "user" },
  { name: "Charlie Brown", email: "charlie@example.com", role: "user" },
]);

// --- SQLite audit storage via callbackStorage ---
// We use callbackStorage instead of drizzleTableStorage because SQLite
// needs Date→string conversion and JSON serialization for text columns.
const auditStorage = callbackStorage(async (entries) => {
  for (const entry of entries) {
    sqliteDb.run(
      `INSERT INTO audit_log (id, table_name, action, row_id, changes, old_data, new_data, user_id, metadata, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tableName,
        entry.action,
        entry.rowId,
        entry.changes ? JSON.stringify(entry.changes) : null,
        entry.oldData ? JSON.stringify(entry.oldData) : null,
        entry.newData ? JSON.stringify(entry.newData) : null,
        entry.userId,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.timestamp instanceof Date ? entry.timestamp.toISOString() : String(entry.timestamp),
      ],
    );
  }
});

// --- Wrap MySQL db with audit → SQLite ---
export const db = withDrizzleAudit(rawDb, {
  storage: auditStorage,
  tables: {
    users: {
      transforms: [mask("email"), redact("password")],
    },
  },
});

export { rawDb, auditDb, sqliteDb, mysqlServer };
