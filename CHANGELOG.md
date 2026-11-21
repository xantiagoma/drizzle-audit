# Changelog

## v0.2.0

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.13...v0.2.0)

### ✨ Highlights

- **First-class `tenantId`.** Set it on the context (`withDrizzleAuditContext({ tenantId })` or the context your `drizzleAuditMiddleware` resolver returns) or per call (`drizzleAuditAction` / `trackAction` option). Every entry gets `entry.tenantId`, resolved as `context.tenantId ?? metadata.tenantId ?? null`, so setups that kept the tenant in `metadata.tenantId` see no change. `shouldAudit` receives it too.
- **Opt-in `tenant_id` column.** `pgAuditTable("audit_log", { tenantId: true })` (also `sqliteAuditTable`, `mysqlAuditTable`) adds a nullable `tenant_id` column and a `(tenant_id, timestamp)` index; `drizzleTableStorage` fills it.
- **`toAuditEntry(row)`.** Normalizes a row read back from any driver (PGlite/`pg`/`postgres`, SQLite, MySQL) into an `AuditEntry`: `timestamp` is always a `Date`, JSON columns are parsed, `id` is a string, snake_case keys are accepted. `AuditEntry.timestamp` stays typed as `Date`.
- **`fallbackStorage`.** `withDrizzleAudit(db, { storage, fallbackStorage, onError })`: when a write fails, the entries are written to `fallbackStorage` first, then `onError` runs exactly as before. If the fallback fails too, `onError` receives an `AggregateError` with both errors.
- **Docs.** README recipe for sending entries to `@xtandard/audit` (ships with that package), and JSDoc examples now import storages and transforms from their real subpath entries (`drizzle-audit/storage/*`, `drizzle-audit/transforms`).
- **Publishing.** Releases are published from CI with npm trusted publishing (OIDC) and provenance.

### 🧭 Migration

No breaking API changes; upgrading needs no code changes. Things to check:

1. **Want a `tenant_id` column?** It is opt-in. Pass `{ tenantId: true }` to your audit table factory and generate a migration (`drizzle-kit generate`). Without it, nothing about your table changes and the tenant is still available in `metadata.tenantId` if you set it there.
2. **Existing `extraColumns` column named `tenantId`:** it is now filled automatically from `entry.tenantId` (context `tenantId`, else `metadata.tenantId`). Previously it stayed `null` unless you filled it yourself. If you used that column for something else, rename it.
3. **Custom `onError` handler:** its `entries` argument now contains only the entries that passed `shouldAudit` (the ones that were actually being written), instead of the full list before sampling/filtering.
4. **Reading rows back:** if you parse audit rows yourself (string timestamps from SQLite/MySQL, JSON text columns), you can replace that code with `toAuditEntry(row)`.
5. **Imports from the root entry:** `drizzleTableStorage`, `consoleStorage`, `redact`, etc. were never exported from `drizzle-audit` at runtime (only the old JSDoc examples suggested it). Import them from `drizzle-audit/storage/drizzle`, `drizzle-audit/storage/console`, `drizzle-audit/transforms`, and so on.

### 🚀 Enhancements

- First-class tenantId and toAuditEntry for reading rows back ([#3](https://github.com/xantiagoma/drizzle-audit/pull/3))
- FallbackStorage for entries whose write failed ([#4](https://github.com/xantiagoma/drizzle-audit/pull/4))

### 📖 Documentation

- Import storages and transforms from their subpaths in JSDoc examples ([#2](https://github.com/xantiagoma/drizzle-audit/pull/2))

### 🤖 CI

- Publish to npm with trusted publishing (OIDC) ([#1](https://github.com/xantiagoma/drizzle-audit/pull/1))

### ❤️ Contributors

- Santiago Montoya A. ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.13

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.12...v0.1.13)

### 🩹 Fixes

- **elysia:** Type plugin as named Elysia instance so .use() preserves consumer types ([5c1002c](https://github.com/xantiagoma/drizzle-audit/commit/5c1002c))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.12

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.11...v0.1.12)

### 🩹 Fixes

- Elysia ALS context lost when derive is async ([09741b0](https://github.com/xantiagoma/drizzle-audit/commit/09741b0))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.11

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.10...v0.1.11)

### 🚀 Enhancements

- SetDrizzleAuditContext, configurable IDs, context propagation docs ([6f75dca](https://github.com/xantiagoma/drizzle-audit/commit/6f75dca))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.10

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.9...v0.1.10)

### 🚀 Enhancements

- Configurable ID system (uuidv7 default) + extraIndexes ([0fd096c](https://github.com/xantiagoma/drizzle-audit/commit/0fd096c))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.9

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.8...v0.1.9)

### 🚀 Enhancements

- OnEntry hook, Drizzle v1 compat, CI improvements ([0811b03](https://github.com/xantiagoma/drizzle-audit/commit/0811b03))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.8

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.7...v0.1.8)

### 🚀 Enhancements

- Async shouldAudit support ([d341c00](https://github.com/xantiagoma/drizzle-audit/commit/d341c00))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.7

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.6...v0.1.7)

### 🚀 Enhancements

- Sampling / shouldAudit for selective auditing ([de8e763](https://github.com/xantiagoma/drizzle-audit/commit/de8e763))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.6

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.5...v0.1.6)

### 🩹 Fixes

- SQLite Date binding + sync interception support ([8ef7452](https://github.com/xantiagoma/drizzle-audit/commit/8ef7452))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.5

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.4...v0.1.5)

### 🚀 Enhancements

- Audit without .returning() + pluggable computeChanges ([eea4eba](https://github.com/xantiagoma/drizzle-audit/commit/eea4eba))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.4

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.3...v0.1.4)

### 🚀 Enhancements

- Deep merge metadata with pluggable strategy ([be2ef1f](https://github.com/xantiagoma/drizzle-audit/commit/be2ef1f))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.3

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.2...v0.1.3)

### 📖 Documentation

- Update README/CLAUDE.md for withContext merge + newContext ([fa91bc2](https://github.com/xantiagoma/drizzle-audit/commit/fa91bc2))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.2

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- WithContext merges, newContext replaces ([8930ef0](https://github.com/xantiagoma/drizzle-audit/commit/8930ef0))

### 🏡 Chore

- Format changelog ([e7448fd](https://github.com/xantiagoma/drizzle-audit/commit/e7448fd))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.1

[compare changes](https://github.com/xantiagoma/drizzle-audit/compare/v0.1.0...v0.1.1)

### 🚀 Enhancements

- Add db.$audit namespace ([06a9b66](https://github.com/xantiagoma/drizzle-audit/commit/06a9b66))

### 🩹 Fixes

- Add auto GitHub Release to publish workflow ([00eb434](https://github.com/xantiagoma/drizzle-audit/commit/00eb434))
- Suppress browser open on release (--no-open) ([7825e17](https://github.com/xantiagoma/drizzle-audit/commit/7825e17))
- Skip GitHub Release if already exists ([6756bd5](https://github.com/xantiagoma/drizzle-audit/commit/6756bd5))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))
