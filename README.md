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

> **Note:** Automatic interception requires `.returning()`. PostgreSQL and SQLite support this natively. For MySQL (which lacks `RETURNING`), use `db.$audit.action()` for manual audit entries — see the [Express+MySQL example](./examples/express-mysql-sqlite/).

## `db.$audit` Namespace

Everything is accessible directly from the wrapped db — no extra imports needed:

```ts
const db = withDrizzleAudit(rawDb, { storage, auditTable: auditLog });

// Custom actions
await db.$audit.action({ action: "VIEW_PII", tableName: "users", rowId: "42" });
db.$audit.action({ action: "LOGIN", userId: email }); // fire-and-forget

// Scoped tracking (using / await using)
{
  using t = db.$audit.track({ action: "PROCESS_ORDER" }); /* ... */
}

// Context (withContext merges, newContext replaces)
await db.$audit.withContext({ metadata: { op: "create" } }, async () => {
  // inherits userId + merges metadata from outer context
  await db.insert(users).values({ name: "Alice" }).returning();
});
await db.$audit.newContext({ userId: null }, async () => {
  /* clean scope */
});
const ctx = db.$audit.context(); // read current context
db.$audit.addMetadata({ requestId: "req_1" }); // mutate current context

// Batch flush
await db.$audit.flush();
console.log(db.$audit.pending); // 0
```

Both approaches are equally valid — use whichever fits your code:

```ts
// Standalone imports — useful when you don't have the db reference
// (e.g. a utility function, a middleware, a background job handler)
import { drizzleAuditAction, withDrizzleAuditContext, trackAction } from "drizzle-audit";

// db.$audit — convenient when you already have db in scope
db.$audit.action({ action: "VIEW_PII" });
```

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

// Default: table "audit_log", UUID v7 (time-sortable)
const auditLog = pgAuditTable();

// UUID v4 (random)
const auditLog = pgAuditTable("audit_log", { idMode: "uuidv4" });

// Custom name
const auditLog = pgAuditTable("app_audit");

// Serial ID + extra columns
const auditLog = pgAuditTable("audit_log", {
  idMode: "serial",
  extraColumns: () => ({
    tenantId: varchar("tenant_id", { length: 64 }),
  }),
});

// Custom ID generator (nanoid, ulid, typeid, etc.)
import { nanoid } from "nanoid";
const auditLog = pgAuditTable("audit_log", {
  idMode: { generate: () => nanoid() },
});

// Extra indexes
import { index } from "drizzle-orm/pg-core";
const auditLog = pgAuditTable("audit_log", {
  extraColumns: () => ({
    tenantId: text("tenant_id").notNull(),
  }),
  extraIndexes: (table) => [index("audit_tenant_action_idx").on(table.tenantId, table.action)],
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

### `withContext` — merges with existing context

`withContext` inherits the outer context and shallow-merges metadata. `userId` is only overridden if explicitly provided.

```ts
// Middleware sets: { userId: "admin", metadata: { ip: "1.2.3.4" } }

await db.$audit.withContext({ metadata: { operation: "edit" } }, async () => {
  // Context is: { userId: "admin", metadata: { ip: "1.2.3.4", operation: "edit" } }
  // userId inherited, metadata merged
});

// Override userId in nested scope
await db.$audit.withContext({ userId: "system" }, async () => {
  // Context is: { userId: "system", metadata: { ip: "1.2.3.4" } }
});
```

### `newContext` — replaces entirely (clean scope)

Use when you don't want to inherit the outer context (e.g. system actions inside a user request):

```ts
await db.$audit.newContext({ userId: null, metadata: { trigger: "cron" } }, async () => {
  // Clean context — nothing from the outer request leaks in
});
```

### `addMetadata` — mutate current context in-place

```ts
db.$audit.addMetadata({ requestId: "req_1", operation: "create-order" });
```

### Deep merge behavior

Metadata is **deep merged** — nested objects are merged recursively, not replaced:

```ts
// Outer: { metadata: { request: { id: "r_1", method: "GET" } } }
await db.$audit.withContext({ metadata: { request: { path: "/api" } } }, async () => {
  // Result: { metadata: { request: { id: "r_1", method: "GET", path: "/api" } } }
  // All three fields preserved — not replaced!
});
```

Arrays and non-object values are replaced entirely (not concatenated).

**Custom merge strategy:**

The merge function is pluggable via the `metadataMerge` option:

```ts
// Use deepmerge-ts instead
import { deepmerge } from "deepmerge-ts";
const db = withDrizzleAudit(rawDb, {
  storage,
  metadataMerge: (override, base) => deepmerge(base, override),
});

// Or disable deep merge entirely (shallow only)
const db = withDrizzleAudit(rawDb, {
  storage,
  metadataMerge: (override, base) => ({ ...base, ...override }),
});
```

### Standalone imports

```ts
import {
  withDrizzleAuditContext, // merges
  newDrizzleAuditContext, // replaces
  addDrizzleAuditMetadata,
} from "drizzle-audit";
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

### Using db.$audit.withContext directly

```ts
// No imports needed
await db.$audit.withContext({ userId: "system", metadata: { script: "migrate" } }, async () => {
  await db.update(users).set({ role: "admin" }).where(eq(users.id, 1)).returning();
});
```

## Custom Audit Actions

Audit events that aren't database operations:

```ts
// Via db.$audit
db.$audit.action({ action: "VIEW_PII", tableName: "users", rowId: "42" }); // fire-and-forget
await db.$audit.action({ action: "LOGIN_FAILED", userId: email }); // awaited (compliance)

// Or via standalone import
import { drizzleAuditAction } from "drizzle-audit";
drizzleAuditAction({ action: "VIEW_PII", tableName: "users", rowId: "42" });
```

## Scoped Tracking (`using` / `await using`)

Track start/end of long operations with automatic duration and status:

```ts
// Via db.$audit
{
  using tracker = db.$audit.track({ action: "PROCESS_ORDER", metadata: { orderId } });
  await validateInventory(orderId);
  tracker.addMetadata({ paymentId: "pay_123" });
  await chargePayment(orderId);
}
// → START entry, then END entry: { status: "completed", duration: 1234 }

// Awaited end (compliance)
{
  await using tracker = db.$audit.track({ action: "BULK_DELETE" });
  // ...
}

// Or via standalone import
import { trackAction } from "drizzle-audit";
{
  using t = trackAction({ action: "PROCESS" });
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

## Sampling

Control which operations get audited — useful for high-traffic tables:

```ts
import { sampleRate, sampleWithOverride, alwaysAudit, neverAudit } from "drizzle-audit";

const db = withDrizzleAudit(rawDb, {
  storage,
  tables: {
    // 10% of page views
    pageViews: { sample: 0.1 },

    // Custom logic: always audit deletes, sample 5% of inserts
    requestLogs: {
      shouldAudit: (ctx) => {
        if (ctx.action === "DELETE") return true;
        return Math.random() < 0.05;
      },
    },

    // Using helpers
    events: { shouldAudit: sampleWithOverride(0.1, (ctx) => ctx.userId === "admin") },
    drafts: { shouldAudit: neverAudit() },
    payments: { shouldAudit: alwaysAudit() },
  },

  // Global: always audit admins, 50% for everyone else
  shouldAudit: (ctx) => {
    if (ctx.userId === "admin") return true;
    return Math.random() < 0.5;
  },
});
```

**Resolution order:** per-table `shouldAudit` → per-table `sample` → global `shouldAudit` → always audit.

The `shouldAudit` function is called **before** diff/transforms — skipping avoids all overhead.

## Customization

### Custom diff / changes format

By default, UPDATE changes are stored as `{ field: { from, to } }`. You can swap the diff algorithm:

```ts
// Use microdiff for deep nested diffs
import diff from "microdiff";

const db = withDrizzleAudit(rawDb, {
  storage,
  computeChanges: (oldData, newData) => {
    const diffs = diff(oldData, newData);
    return diffs.length === 0 ? null : { _diffs: diffs };
  },
});

// Use JSON Patch format
import { compare } from "fast-json-patch";

const db = withDrizzleAudit(rawDb, {
  storage,
  computeChanges: (oldData, newData) => {
    const patches = compare(oldData, newData);
    return patches.length === 0 ? null : { _patches: patches };
  },
});
```

### Custom metadata merge

See [Deep merge behavior](#deep-merge-behavior) above — configurable via `metadataMerge`.

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
  await db.$audit.flush();
});

// Flush on interval (long-running workers)
setInterval(() => db.$audit.flush(), 5000);

// Check pending count
console.log(db.$audit.pending);
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

## Event Hook (`onEntry`)

React to every audit entry in real-time — before it's written to storage:

```ts
const db = withDrizzleAudit(rawDb, {
  storage,
  onEntry: async (entry) => {
    // Send Slack alert on deletes
    if (entry.action === "DELETE") {
      await slack.send(`${entry.tableName}#${entry.rowId} deleted by ${entry.userId}`);
    }
    // Log to observability
    logger.info({ audit: entry, traceId: getTraceId() });
  },
});
```

Errors in `onEntry` are caught and logged — they never block the storage write.

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

| Export                          | Description                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `withDrizzleAudit(db, options)` | Wrap a Drizzle db for automatic audit logging. Returns `db` with `$audit` namespace |
| `drizzleAuditAction(options)`   | Log a custom audit entry (works without db reference)                               |
| `trackAction(options)`          | Scoped tracking with `using`/`await using` (works without db reference)             |

### `db.$audit` Namespace

Same functionality accessible from the wrapped db instance — convenient when db is in scope:

| Method                           | Description                                |
| -------------------------------- | ------------------------------------------ |
| `db.$audit.action(options)`      | Log a custom audit entry                   |
| `db.$audit.track(options)`       | Scoped tracking with `using`/`await using` |
| `db.$audit.withContext(ctx, fn)` | Merge context and run function             |
| `db.$audit.newContext(ctx, fn)`  | Replace context entirely and run function  |
| `db.$audit.context()`            | Get current context (`null` if none)       |
| `db.$audit.addMetadata(data)`    | Merge metadata into current context        |
| `db.$audit.flush()`              | Flush buffered entries (batch mode)        |
| `db.$audit.pending`              | Number of buffered entries                 |

### Context (standalone imports — useful when db is not in scope)

| Export                             | Description                                  |
| ---------------------------------- | -------------------------------------------- |
| `withDrizzleAuditContext(ctx, fn)` | Merge with existing context and run function |
| `newDrizzleAuditContext(ctx, fn)`  | Replace context entirely and run function    |
| `useDrizzleAuditContext()`         | Get current context (`null` if none)         |
| `getDrizzleAuditContext()`         | Get current context (throws if none)         |
| `addDrizzleAuditMetadata(data)`    | Merge metadata into current context          |

### Schema

| Export                              | Description                              |
| ----------------------------------- | ---------------------------------------- |
| `pgAuditTable(name?, options?)`     | PostgreSQL audit table (UUID v7 default) |
| `sqliteAuditTable(name?, options?)` | SQLite audit table                       |
| `mysqlAuditTable(name?, options?)`  | MySQL audit table                        |

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
