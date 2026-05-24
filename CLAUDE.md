# drizzle-audit

TypeScript library for configurable audit logging with Drizzle ORM.

## Tooling

- **Package manager**: Bun (`bun install`, `bun run <script>`, `bunx <pkg>`)
- **Toolchain**: Vite+ (`vp`) — all-in-one: test, lint, fmt, build
- **Node**: Managed via mise (requires >= 22.18.0 for TS config support)

## Scripts

- `bun run test` — run tests (vitest via `vp test run`)
- `bun run test:coverage` — tests with v8 coverage report + HTML
- `bun run test:coverage:open` — same + opens in browser
- `bun run lint` — lint (oxlint via `vp lint`)
- `bun run format` — format (oxfmt via `vp fmt`)
- `bun run check` — lint + format check + typecheck
- `bun run build` — build library (tsdown via `vp pack`, outputs CJS + ESM + DTS to `dist/`)
- `bun run example:basic` — Hono + PGlite example (port auto-detected)
- `bun run example:mongo` — Elysia + PGlite + MongoDB example
- `bun run example:express` — Express + MySQL + SQLite example

## Config

All tool configuration lives in `vite.config.ts` (vite-plus unified config).
Do NOT create separate config files for vitest, oxlint, or oxfmt.

## Testing

Use vitest (via `vp test run`). Import from `vitest`, not `bun:test`.

```ts
import { test, expect, describe } from "vitest";
```

PGlite for in-memory PG tests. Test files go in `test/`.

## Project Structure

```
src/
  index.ts              — main barrel export
  pg.ts, sqlite.ts, mysql.ts — dialect entry points
  types.ts              — all types
  with-drizzle-audit.ts — main Proxy wrapper
  audit-action.ts       — custom audit entries
  audit-action-internal.ts — shared global storage ref
  track-action.ts       — using/await using scoped tracking
  context.ts            — AsyncLocalStorage context
  diff.ts               — diff computation
  schema/               — audit table factories per dialect
  transforms/           — redact, mask, hash, omit
  storage/              — drizzle, console, callback, multi, http adapters
  middleware/            — hono, elysia, fetch, node, trpc, orpc, graphql, worker
test/                   — all test files (201 tests)
examples/
  basic/                — Hono + PGlite + same-DB audit
  mongo/                — Elysia + PGlite + MongoDB audit
  express-mysql-sqlite/ — Express + MySQL + SQLite audit
tmp/                    — gitignored scratch/reference (not committed)
```

## Key Patterns

- Proxy-based interception (not object spread) for wrapping drizzle db
- AsyncLocalStorage with `Symbol.for('drizzle-audit:als')` for context
- Separate ALS `Symbol.for('drizzle-audit:tx-db')` for transaction-scoped storage
- Delta-based changes by default (`dataMode: 'changes-only'`)
- UUID v7 default for audit entry IDs (configurable: uuidv7, uuidv4, serial, or custom generator)
- Schema factories support `extraColumns` + `extraIndexes` for full customization
- `auditTable` option auto-excludes audit table from being audited (prevents recursion)
- No-op UPDATE detection (skips audit when nothing changed)
- Automatic interception requires `.returning()` — MySQL needs manual `drizzleAuditAction()`
- `drizzle-orm >= 0.33.0 < 2` as peer dependency
- `withDrizzleAuditContext` MERGES with existing context, `newDrizzleAuditContext` REPLACES
- `db.$audit` namespace exposes all audit functionality from the db instance
- ALS propagation: `run()` (safe) for Hono/Express/Koa/tRPC/oRPC/Fetch/Worker; `enterWith` (fragile) for Elysia/Yoga/GraphQL
- `setDrizzleAuditContext` / `db.$audit.setContext` for imperative context setting (escape hatch for embedded frameworks)
- All examples use `get-port-please` for automatic port selection

## IMPORTANT: Before Every Commit / Release

**ALWAYS update these when making changes:**

1. **README.md** — update relevant sections, API reference tables, and code examples
2. **TSDoc** — update JSDoc on any modified public exports
3. **CLAUDE.md** — update if patterns, structure, or key decisions change
4. **Tests** — add/update tests for any new or changed behavior
5. **CHANGELOG** — handled automatically by `changelogen` via conventional commits

**Never commit code changes without updating the corresponding docs.**
