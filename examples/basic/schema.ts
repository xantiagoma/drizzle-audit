import { pgTable, serial, text, varchar, timestamp } from "drizzle-orm/pg-core";
import { pgAuditTable } from "../../src/pg.ts";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const auditLog = pgAuditTable();
