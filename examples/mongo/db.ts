import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { withDrizzleAudit } from "../../src/index.ts";
import { callbackStorage } from "../../src/storage/callback.ts";
import { mask } from "../../src/transforms/index.ts";
import type { AuditEntry } from "../../src/types.ts";
import * as schema from "./schema.ts";

// --- Start MongoDB (in-memory) ---
console.log("Starting MongoDB...");
const mongod = await MongoMemoryServer.create();
const mongoUrl = mongod.getUri();
console.log(`MongoDB running at ${mongoUrl}`);

const mongoClient = new MongoClient(mongoUrl);
await mongoClient.connect();
const mongoDb = mongoClient.db("drizzle_audit_example");
const auditCollection = mongoDb.collection<AuditEntry>("audit_log");

// Indexes for efficient querying
await auditCollection.createIndex({ tableName: 1 });
await auditCollection.createIndex({ action: 1 });
await auditCollection.createIndex({ userId: 1 });
await auditCollection.createIndex({ rowId: 1 });
await auditCollection.createIndex({ timestamp: -1 });

// --- Start PostgreSQL (PGlite in-memory) ---
const client = new PGlite();
const rawDb = drizzle(client, { schema });

const migrationsFolder = new URL("../basic/migrations", import.meta.url).pathname;
await migrate(rawDb, { migrationsFolder });

// Seed
await rawDb.insert(schema.users).values([
  { name: "Alice Johnson", email: "alice@example.com", role: "admin" },
  { name: "Bob Smith", email: "bob@example.com", role: "user" },
  { name: "Charlie Brown", email: "charlie@example.com", role: "user" },
]);

// --- MongoDB storage adapter ---
const mongoStorage = callbackStorage(async (entries) => {
  await auditCollection.insertMany(entries);
});

// --- Wrap Drizzle with audit → MongoDB ---
export const db = withDrizzleAudit(rawDb, {
  storage: mongoStorage,
  // No auditTable needed — audit goes to MongoDB, not the same PG database
  tables: {
    users: {
      transforms: [mask("email")],
    },
  },
});

export { rawDb, auditCollection, mongoClient, mongod };
