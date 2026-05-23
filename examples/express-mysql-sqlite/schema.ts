import { mysqlTable, serial, varchar, timestamp } from "drizzle-orm/mysql-core";
import { sqliteAuditTable } from "../../src/sqlite.ts";

// App schema — MySQL
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Audit schema — SQLite (separate database)
export const auditLog = sqliteAuditTable();
