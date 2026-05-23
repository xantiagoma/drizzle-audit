<p align="center">
  <img src="./assets/logo.png" alt="drizzle-audit" width="180" />
</p>

<h1 align="center">drizzle-audit</h1>

<p align="center">
  Configurable audit logging for <a href="https://orm.drizzle.team/">Drizzle ORM</a>.<br/>
  Track database changes and custom actions with pluggable storage, automatic context propagation, and field-level transforms.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/drizzle-audit"><img src="https://img.shields.io/npm/v/drizzle-audit?color=blue" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/drizzle-audit"><img src="https://img.shields.io/npm/dm/drizzle-audit" alt="npm downloads" /></a>
  <a href="https://github.com/xantiagoma/drizzle-audit/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/drizzle-audit" alt="license" /></a>
  <a href="https://github.com/xantiagoma/drizzle-audit"><img src="https://img.shields.io/github/stars/xantiagoma/drizzle-audit?style=social" alt="stars" /></a>
</p>

---

## Features

- **Zero-config start** — wrap your db, get full CRUD audit logging
- **Progressive enhancement** — add context, transforms, external storage as needed
- **Delta-based** — stores only what changed (configurable to full snapshots)
- **Custom actions** — audit non-DB events (logins, exports, PII views)
- **Scoped tracking** — `using`/`await using` for start/end with duration
- **Transforms** — redact, mask, hash, omit sensitive fields
- **Pluggable storage** — same DB, different DB, HTTP webhook, MongoDB, or anything custom
- **AsyncLocalStorage context** — automatic user/request attribution
- **Framework middleware** — Hono, Elysia, Express, Fastify, Koa, tRPC, oRPC, GraphQL, and generic WHATWG fetch
- **Worker support** — BullMQ, Temporal, Inngest, Cloudflare Workers, cron jobs
- **Transaction-aware** — audit writes use the same connection inside transactions
- **Multi-dialect** — PostgreSQL, SQLite, MySQL
- **Type-safe** — strict TypeScript, no `any` in public API

## Install

```bash
bun add drizzle-audit
# or
npm install drizzle-audit
# or
pnpm add drizzle-audit
```

## Quick Start

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { withDrizzleAudit } from "drizzle-audit";
import { drizzleTableStorage } from "drizzle-audit/storage/drizzle";
import { pgAuditTable } from "drizzle-audit/pg";

// 1. Create the audit table in your schema (works with drizzle-kit)
export const auditLog = pgAuditTable();

// 2. Wrap your drizzle instance
const rawDb = drizzle(client);
const db = withDrizzleAudit(rawDb, {
  storage: drizzleTableStorage(auditLog, { db: rawDb }),
  auditTable: auditLog, // prevents auditing the audit table itself
});

// 3. Use normally — changes are audited automatically
await db.insert(users).values({ name: "Alice" }).returning();
// → { action: "INSERT", tableName: "users", changes: { id: 1, name: "Alice", ... } }

await db.update(users).set({ name: "Bob" }).where(eq(users.id, 1)).returning();
// → { action: "UPDATE", changes: { name: { from: "Alice", to: "Bob" } } }

await db.delete(users).where(eq(users.id, 1)).returning();
// → { action: "DELETE", changes: { id: 1, name: "Bob", ... } }
```

No context needed — `userId` will be `null` but all data changes are captured. No-op updates (where nothing actually changed) are automatically skipped.

> **Note:** Automatic interception requires `.returning()`. PostgreSQL and SQLite support this natively. For MySQL (which lacks `RETURNING`), use `drizzleAuditAction()` for manual audit entries — see the [Express+MySQL example](./examples/express-mysql-sqlite/).

## Examples

Three interactive web demos are included:

```bash
bun run example:basic    # Hono + PGlite + same-DB audit
bun run example:mongo    # Elysia + PGlite + MongoDB audit
bun run example:express  # Express + MySQL + SQLite audit
```

Each runs fully in-memory — no Docker or external services needed.

## Audit Table Schema

Each dialect has a factory function that returns a **standard Drizzle table** — it works with `drizzle-kit` migrations, queries, and everything else exactly like any table you define yourself.

```ts
// schema.ts — export alongside your other tables
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { pgAuditTable } from "drizzle-audit/pg";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

// This is just a pgTable() with pre-configured audit columns + indexes
export const auditLog = pgAuditTable();
```

```bash
# drizzle-kit sees it like any other table
bunx drizzle-kit generate  # generates CREATE TABLE audit_log migration
bunx drizzle-kit push       # pushes to DB
```

```ts
// You can query it directly with Drizzle
const history = await db.select().from(auditLog).where(eq(auditLog.tableName, "users"));
```

**Options:**

```ts
import { pgAuditTable } from "drizzle-audit/pg";
import { sqliteAuditTable } from "drizzle-audit/sqlite";
import { mysqlAuditTable } from "drizzle-audit/mysql";

// Default: table "audit_log", UUID primary key
const auditLog = pgAuditTable();

// Custom name
const auditLog = pgAuditTable("app_audit");

// Serial ID + extra columns
const auditLog = pgAuditTable("audit_log", {
  idMode: "serial",
  extraColumns: () => ({
    tenantId: varchar("tenant_id", { length: 64 }),
  }),
});
```

## Table Scoping

Control which tables are audited:

```ts
// Audit everything (default)
const db = withDrizzleAudit(rawDb, { storage, tables: "all" });

// Only specific tables
const db = withDrizzleAudit(rawDb, { storage, tables: [users, orders] });

// Everything except these
const db = withDrizzleAudit(rawDb, {
  storage,
  tables: { exclude: [sessions, migrations] },
});

// Per-table config with transforms
const db = withDrizzleAudit(rawDb, {
  storage,
  tables: {
    users: { transforms: [redact("password")] },
    orders: true, // audit with defaults
  },
});
```

## Data Modes

Control what data is stored per audit entry:

```ts
const db = withDrizzleAudit(rawDb, {
  storage,
  dataMode: "changes-only", // default — only deltas
  // dataMode: "full-snapshots",  // full old_data + new_data
  // dataMode: "both",            // deltas + snapshots

  // Per-table override
  tables: {
    users: { dataMode: "changes-only" },
    payments: { dataMode: "both" },
  },
});
```

**Delta format for UPDATE:** `{ name: { from: "Alice", to: "Bob" } }`
**For INSERT:** all fields as values. **For DELETE:** all fields as last known values.

## Context (AsyncLocalStorage)

Track who performed each action. Context is always optional — without it, `userId` is `null`.

```ts
import { withDrizzleAuditContext, addDrizzleAuditMetadata } from "drizzle-audit";

// Wrap any scope with context
await withDrizzleAuditContext({ userId: req.user.id, metadata: { ip: req.ip } }, async () => {
  await db.update(users).set({ name: "Bob" }).where(eq(users.id, 1)).returning();
  // → audit entry includes userId and metadata automatically
});

// Add metadata mid-request
addDrizzleAuditMetadata({ operation: "update-profile" });
```

## Framework Middleware

### Hono

```ts
import { drizzleAuditMiddleware } from "drizzle-audit/middleware/hono";

app.use(
  "*",
  drizzleAuditMiddleware((c) => ({
    userId: c.get("user")?.id ?? null,
    metadata: { ip: c.req.header("x-forwarded-for"), path: c.req.path },
  })),
);
```

### Elysia

```ts
import { drizzleAuditPlugin } from "drizzle-audit/middleware/elysia";

app.use(
  drizzleAuditPlugin({
    getContext: ({ headers }) => ({
      userId: headers["x-user-id"] ?? null,
    }),
  }),
);
// Also exposes `auditContext` on Elysia handler context
```

### Express / Fastify / NestJS (Node HTTP)

```ts
import { drizzleAuditNodeMiddleware } from "drizzle-audit/middleware/node";

app.use(
  drizzleAuditNodeMiddleware((req) => ({
    userId: (req.headers["x-user-id"] as string) ?? null,
    metadata: { method: req.method, path: req.url },
  })),
);
```

### Koa

```ts
import { drizzleAuditKoaMiddleware } from "drizzle-audit/middleware/node";

app.use(
  drizzleAuditKoaMiddleware((ctx) => ({
    userId: ctx.state.user?.id ?? null,
    metadata: { ip: ctx.ip, path: ctx.path },
  })),
);
```

### Generic WHATWG Fetch (Bun.serve, Cloudflare Workers, Deno.serve, itty-router)

```ts
import { drizzleAuditFetch } from "drizzle-audit/middleware/fetch";

Bun.serve({
  fetch: drizzleAuditFetch(
    (req) => ({ userId: req.headers.get("x-user-id") }),
    (req) => new Response("ok"),
  ),
});
```

### tRPC

```ts
import { drizzleAuditTRPCMiddleware } from "drizzle-audit/middleware/trpc";

const auditMiddleware = t.middleware(
  drizzleAuditTRPCMiddleware((opts) => ({
    userId: opts.ctx.user?.id ?? null,
    metadata: { path: opts.path, type: opts.type },
  })),
);
const protectedProcedure = t.procedure.use(auditMiddleware);
```

### oRPC

```ts
import { drizzleAuditORPCMiddleware } from "drizzle-audit/middleware/orpc";

const auditMiddleware = drizzleAuditORPCMiddleware((_input, context) => ({
  userId: context.user?.id ?? null,
}));
```

### GraphQL (Yoga, Apollo)

```ts
import {
  drizzleAuditGraphQLContext,
  drizzleAuditYogaPlugin,
} from "drizzle-audit/middleware/graphql";

// Yoga — as plugin
const yoga = createYoga({
  plugins: [
    drizzleAuditYogaPlugin((req) => ({
      userId: req.headers.get("x-user-id") ?? null,
    })),
  ],
});

// Apollo — as context factory
context: drizzleAuditGraphQLContext(
  ({ req }) => ({ userId: req.headers["x-user-id"] ?? null }),
  (serverCtx, auditCtx) => ({ ...serverCtx, audit: auditCtx }),
);
```

## Background Jobs & Workers

### Generic handler wrapper (BullMQ, Temporal, Inngest, etc.)

```ts
import { drizzleAuditHandler, drizzleAuditWrap } from "drizzle-audit/middleware/worker";

// Dynamic context from job args — works with any framework
new Worker(
  "emails",
  drizzleAuditHandler(
    (job) => ({
      userId: job.data.triggeredBy,
      metadata: { jobId: job.id, queue: job.queueName },
    }),
    async (job) => {
      await db.update(emails).set({ status: "sent" }).where(eq(emails.id, job.data.emailId));
    },
  ),
);

// Static context for cron/scripts
const cleanup = drizzleAuditWrap({ userId: null, metadata: { trigger: "cron" } }, async () => {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
});
await cleanup();
```

### Using withDrizzleAuditContext directly

```ts
import { withDrizzleAuditContext } from "drizzle-audit";

await withDrizzleAuditContext({ userId: "system", metadata: { script: "migrate" } }, async () => {
  await db.update(users).set({ role: "admin" }).where(eq(users.id, 1)).returning();
});
```

## Custom Audit Actions

Audit events that aren't database operations:

```ts
import { drizzleAuditAction } from "drizzle-audit";

// Fire-and-forget (don't await)
drizzleAuditAction({
  action: "VIEW_PII",
  tableName: "users",
  rowId: "42",
  metadata: { fields: ["email", "ssn"] },
});

// Awaited (compliance — must confirm it was logged)
await drizzleAuditAction({
  action: "LOGIN_FAILED",
  userId: email,
  metadata: { ip: req.ip, reason: "invalid_password" },
});
```

## Scoped Tracking (`using` / `await using`)

Track start/end of long operations with automatic duration and status:

```ts
import { trackAction } from "drizzle-audit";

// Fire-and-forget end
{
  using tracker = trackAction({ action: "PROCESS_ORDER", metadata: { orderId } });
  await validateInventory(orderId);
  tracker.addMetadata({ paymentId: "pay_123" });
  await chargePayment(orderId);
}
// → START entry, then END entry: { status: "completed", duration: 1234 }

// Awaited end (compliance)
{
  await using tracker = trackAction({ action: "BULK_DELETE" });
  // ...
}
```

## Transforms

Sanitize sensitive data before storage:

```ts
import { redact, mask, hash, omit } from "drizzle-audit/transforms";

const db = withDrizzleAudit(rawDb, {
  storage,
  tables: {
    users: {
      transforms: [
        redact("password", "resetToken"), // → "[REDACTED]"
        mask("email"), // → "a***@e***.com"
        mask("phone"), // → "****5678"
        hash("ssn"), // → "hash:a1b2c3d4"
        omit("avatarBlob"), // removed entirely
      ],
    },
  },
  // Global transform — applied to all tables
  transform: (entry) => ({
    ...entry,
    metadata: { ...entry.metadata, env: process.env.NODE_ENV },
  }),
});
```

## Transactions

Audit writes inside transactions use the same connection — no deadlocks:

```ts
await db.transaction(async (tx) => {
  await tx.insert(orders).values({ userId: 1, total: 5000 }).returning();
  await tx.insert(orderItems).values({ orderId: 1, productId: 1 }).returning();
  // Both INSERT audit entries written via the transaction connection
  // If tx rolls back, audit entries roll back too
});
```

## Flush Modes

Control when audit entries are sent to storage:

```ts
// Immediate (default) — write after each operation
const db = withDrizzleAudit(rawDb, { storage, flushMode: "immediate" });

// Batch — buffer entries, flush manually or at end of request
const db = withDrizzleAudit(rawDb, { storage, flushMode: "batch" });

// Flush at end of request (Hono example)
app.use("*", async (c, next) => {
  await next();
  await db.$flushAudit();
});

// Flush on interval (long-running workers)
setInterval(() => db.$flushAudit(), 5000);
```

## Storage Adapters

### Same database (default)

```ts
import { drizzleTableStorage } from "drizzle-audit/storage/drizzle";

const db = withDrizzleAudit(rawDb, {
  storage: drizzleTableStorage(auditLog, { db: rawDb }),
  auditTable: auditLog, // prevent infinite recursion
});
```

### Different database

```ts
const auditDb = drizzle(postgres(AUDIT_DB_URL));
storage: drizzleTableStorage(auditLog, { db: auditDb });
// No auditTable needed — different database, no recursion risk
```

### Console (development)

```ts
import { consoleStorage } from "drizzle-audit/storage/console";
storage: consoleStorage();
```

### HTTP webhook

```ts
import { httpStorage } from "drizzle-audit/storage/http";
storage: httpStorage({
  url: "https://audit.internal/ingest",
  headers: { Authorization: "Bearer ..." },
  retries: 3,
  flushIntervalMs: 1000,
});
```

### Multiple destinations (fan-out)

```ts
import { multiStorage } from "drizzle-audit/storage/multi";
storage: multiStorage([
  drizzleTableStorage(auditLog, { db: rawDb }),
  httpStorage({ url: "https://..." }),
  consoleStorage(),
]);
```

### Custom (anything — MongoDB, Redis, Kafka, S3, etc.)

```ts
import { callbackStorage } from "drizzle-audit/storage/callback";
storage: callbackStorage(async (entries) => {
  await mongo.collection("audit").insertMany(entries);
});
```

## Error Handling

```ts
const db = withDrizzleAudit(rawDb, {
  storage,
  onError: "warn", // default — console.warn, don't block
  // onError: "throw",   // audit failure = operation failure
  // onError: "ignore",  // silent
  // onError: (error, entries) => { Sentry.captureException(error) },
});
```

## API Reference

### Core

| Export                          | Description                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `withDrizzleAudit(db, options)` | Wrap a Drizzle db for automatic audit logging. Returns `db` with `$flushAudit()` and `$pendingAuditEntries` |
| `drizzleAuditAction(options)`   | Log a custom (non-DB) audit entry                                                                           |
| `trackAction(options)`          | Scoped tracking with `using`/`await using`                                                                  |

### Context

| Export                             | Description                          |
| ---------------------------------- | ------------------------------------ |
| `withDrizzleAuditContext(ctx, fn)` | Run a function with audit context    |
| `useDrizzleAuditContext()`         | Get current context (`null` if none) |
| `getDrizzleAuditContext()`         | Get current context (throws if none) |
| `addDrizzleAuditMetadata(data)`    | Merge metadata into current context  |

### Schema

| Export                              | Description                           |
| ----------------------------------- | ------------------------------------- |
| `pgAuditTable(name?, options?)`     | PostgreSQL audit table (UUID default) |
| `sqliteAuditTable(name?, options?)` | SQLite audit table                    |
| `mysqlAuditTable(name?, options?)`  | MySQL audit table                     |

### Transforms (`drizzle-audit/transforms`)

| Export              | Description                             |
| ------------------- | --------------------------------------- |
| `redact(...fields)` | Replace values with `[REDACTED]`        |
| `mask(...fields)`   | Partially mask values (`a***@e***.com`) |
| `hash(...fields)`   | One-way hash values                     |
| `omit(...fields)`   | Remove fields entirely                  |

### Storage

| Export                              | From                             | Description              |
| ----------------------------------- | -------------------------------- | ------------------------ |
| `drizzleTableStorage(table, opts?)` | `drizzle-audit/storage/drizzle`  | Write to a Drizzle table |
| `consoleStorage(opts?)`             | `drizzle-audit/storage/console`  | Pretty-print to console  |
| `httpStorage(opts)`                 | `drizzle-audit/storage/http`     | POST to HTTP endpoint    |
| `callbackStorage(fn)`               | `drizzle-audit/storage/callback` | Custom function          |
| `multiStorage(adapters)`            | `drizzle-audit/storage/multi`    | Fan-out to multiple      |

### Middleware

| Export                        | From                               | For                               |
| ----------------------------- | ---------------------------------- | --------------------------------- |
| `drizzleAuditFetch`           | `drizzle-audit/middleware/fetch`   | Bun.serve, CF Workers, Deno.serve |
| `drizzleAuditFetchMiddleware` | `drizzle-audit/middleware/fetch`   | Generic `(req, next)` pattern     |
| `drizzleAuditMiddleware`      | `drizzle-audit/middleware/hono`    | Hono                              |
| `drizzleAuditPlugin`          | `drizzle-audit/middleware/elysia`  | Elysia                            |
| `drizzleAuditNodeMiddleware`  | `drizzle-audit/middleware/node`    | Express, Fastify, NestJS          |
| `drizzleAuditKoaMiddleware`   | `drizzle-audit/middleware/node`    | Koa                               |
| `drizzleAuditTRPCMiddleware`  | `drizzle-audit/middleware/trpc`    | tRPC                              |
| `drizzleAuditORPCMiddleware`  | `drizzle-audit/middleware/orpc`    | oRPC                              |
| `drizzleAuditGraphQLContext`  | `drizzle-audit/middleware/graphql` | Apollo, Yoga (context)            |
| `drizzleAuditYogaPlugin`      | `drizzle-audit/middleware/graphql` | GraphQL Yoga (plugin)             |
| `drizzleAuditHandler`         | `drizzle-audit/middleware/worker`  | BullMQ, Temporal, Inngest         |
| `drizzleAuditWrap`            | `drizzle-audit/middleware/worker`  | Static context for cron/scripts   |

### Utilities

| Export                           | Description                                  |
| -------------------------------- | -------------------------------------------- |
| `computeDiff(old, new, opts?)`   | Compute field-level diff between two objects |
| `buildChanges(action, old, new)` | Build delta object for audit entry           |

## Alternatives

| Project                                                                                            | Approach                                                                     | Tradeoffs                                                                     |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Bemi](https://github.com/BemiHQ/bemi-io-drizzle)                                                  | Patches `session.prepareQuery`, injects SQL comments, CDC via PostgreSQL WAL | Postgres-only, requires their SaaS backend, no self-hosted                    |
| [wovalle/drizzle_audit](https://github.com/wovalle/willy.im/tree/main/packages/drizzle_audit)      | PG triggers + SQLite triggers + runtime wrapper                              | Not published on npm, breaks Drizzle chain API, composite PK issues           |
| [nestjs-drizzle-auditing](https://github.com/rrodrigofranco/nestjs-drizzle-auditing)               | NestJS interceptor + `@Auditable` decorator                                  | MySQL-only, uses `req.body` as "old value" (not actual DB state), `any` types |
| [Supabase supa_audit](https://github.com/supabase/supa_audit)                                      | PostgreSQL extension with PL/pgSQL triggers                                  | Postgres-only, DB-level (no app context like userId)                          |
| [Atlas Triggers](https://atlasgo.io/guides/orms/drizzle/triggers)                                  | Managed PG triggers via Atlas tool                                           | Requires Atlas Pro, Postgres-only                                             |
| [Prisma Audit Log](https://github.com/prisma/prisma-client-extensions/tree/main/audit-log-context) | Prisma client extension with middleware                                      | Prisma-only                                                                   |

**drizzle-audit** differs by being dialect-agnostic, fully self-hosted, working at the application level with AsyncLocalStorage context, and providing pluggable storage to any destination.

## See Also

- [drizzle-cursor](https://github.com/xantiagoma/drizzle-cursor) — Cursor-based pagination for Drizzle ORM (by the same author)

## License

MIT
