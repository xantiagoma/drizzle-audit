import type { Table } from "drizzle-orm";

// --- Audit Entry ---

/**
 * Controls what data is stored in audit entries.
 *
 * - `'changes-only'` — Store only deltas (what changed). Default.
 * - `'full-snapshots'` — Store complete `oldData` and `newData` snapshots.
 * - `'both'` — Store both deltas and full snapshots.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   dataMode: 'changes-only', // global default
 *   tables: {
 *     payments: { dataMode: 'both' }, // per-table override
 *   },
 * })
 * ```
 */
export type DataMode = "changes-only" | "full-snapshots" | "both";

/**
 * A single audit log entry representing a database operation or custom action.
 *
 * @example
 * ```ts
 * // INSERT entry
 * {
 *   id: '550e8400-e29b-41d4-a716-446655440000',
 *   tableName: 'users',
 *   action: 'INSERT',
 *   rowId: '1',
 *   changes: { id: 1, name: 'Alice', email: 'alice@example.com' },
 *   oldData: null,
 *   newData: null,
 *   timestamp: new Date(),
 *   userId: 'admin_1',
 *   metadata: { ip: '1.2.3.4' },
 * }
 *
 * // UPDATE entry (changes-only mode)
 * {
 *   action: 'UPDATE',
 *   changes: { name: { from: 'Alice', to: 'Bob' } },
 *   // only changed fields are stored
 * }
 * ```
 */
export interface AuditEntry {
  /** Unique identifier for this audit entry (UUID by default) */
  id: string;
  /** Name of the database table affected, or `null` for custom actions */
  tableName: string | null;
  /** The action performed: `'INSERT'`, `'UPDATE'`, `'DELETE'`, or any custom string */
  action: string;
  /** Primary key of the affected row as a string, or `null` for custom actions */
  rowId: string | null;
  /** Delta of what changed. Format depends on action type. `null` when `dataMode` is `'full-snapshots'` */
  changes: Record<string, unknown> | null;
  /** Full state before the operation. `null` for INSERT or when `dataMode` is `'changes-only'` */
  oldData: Record<string, unknown> | null;
  /** Full state after the operation. `null` for DELETE or when `dataMode` is `'changes-only'` */
  newData: Record<string, unknown> | null;
  /** When the action occurred */
  timestamp: Date;
  /** Who performed the action, from audit context. `null` if no context is active */
  userId: string | null;
  /** Arbitrary metadata from audit context (IP, request ID, etc.) */
  metadata: Record<string, unknown> | null;
}

// --- Storage ---

/**
 * Interface for audit entry storage backends.
 * Implement this to send audit entries to any destination.
 *
 * @example
 * ```ts
 * // Custom MongoDB storage
 * const mongoStorage: AuditStorage = {
 *   async write(entries) {
 *     await mongo.collection('audit').insertMany(entries)
 *   },
 *   async flush() {
 *     // optional: flush any buffered writes
 *   },
 *   async close() {
 *     // optional: cleanup resources
 *   },
 * }
 * ```
 */
export interface AuditStorage {
  /** Persist one or more audit entries */
  write(entries: AuditEntry[]): Promise<void>;
  /** Optional: flush any buffered writes */
  flush?(): Promise<void>;
  /** Optional: cleanup resources on shutdown */
  close?(): Promise<void>;
}

// --- Context ---

/**
 * Audit context that identifies who performed an action and provides metadata.
 * Set via {@link withDrizzleAuditContext} or framework middleware.
 *
 * @example
 * ```ts
 * const context: DrizzleAuditContext = {
 *   userId: 'u_123',
 *   metadata: { ip: '1.2.3.4', requestId: 'req_abc' },
 * }
 * ```
 */
export interface DrizzleAuditContext {
  /** The user or actor performing the action. `null` for system/anonymous */
  userId: string | null;
  /** Arbitrary metadata (IP, request ID, tenant, etc.) */
  metadata?: Record<string, unknown> | null;
}

// --- Transforms ---

/**
 * A function that transforms an audit entry before it is stored.
 * Used to redact, mask, hash, or omit sensitive fields.
 *
 * @example
 * ```ts
 * const myTransform: AuditTransform = (entry) => ({
 *   ...entry,
 *   metadata: { ...entry.metadata, env: 'production' },
 * })
 * ```
 */
export type AuditTransform = (entry: AuditEntry) => AuditEntry;

// --- Table Config ---

/**
 * Per-table audit configuration.
 *
 * @example
 * ```ts
 * const config: TableAuditConfig = {
 *   dataMode: 'both',
 *   transforms: [redact('password'), mask('email')],
 * }
 * ```
 */
export interface TableAuditConfig {
  /** Override the global `dataMode` for this table */
  dataMode?: DataMode;
  /** Transforms to apply to entries for this table */
  transforms?: AuditTransform[];
}

/** Configuration to exclude specific tables from auditing */
export interface TablesExcludeConfig {
  /** Tables to exclude from auditing */
  exclude: Table[];
}

/**
 * Controls which tables are audited and how.
 *
 * @example
 * ```ts
 * // Audit everything
 * tables: 'all'
 *
 * // Only specific tables
 * tables: [users, orders]
 *
 * // Everything except these
 * tables: { exclude: [sessions, migrations] }
 *
 * // Per-table config
 * tables: {
 *   users: { transforms: [redact('password')] },
 *   orders: true,
 * }
 * ```
 */
export type TablesConfig =
  | "all"
  | Table[]
  | TablesExcludeConfig
  | Record<string, true | TableAuditConfig>;

// --- Error Handling ---

/**
 * How to handle errors when writing audit entries.
 *
 * - `'throw'` — Propagate the error (audit failure = operation failure)
 * - `'warn'` — Log a warning, don't block the operation (default)
 * - `'ignore'` — Silently swallow errors
 * - `(error, entries) => void` — Custom error handler
 */
export type AuditErrorHandler =
  | "throw"
  | "warn"
  | "ignore"
  | ((error: unknown, entries: AuditEntry[]) => void);

// --- Flush Mode ---

/**
 * Controls when audit entries are sent to storage.
 *
 * - `'immediate'` — Write after each operation (default)
 * - `'batch'` — Buffer entries, write when `$flushAudit()` is called
 *
 * @example
 * ```ts
 * // Immediate (default)
 * const db = withDrizzleAudit(rawDb, { storage, flushMode: 'immediate' })
 *
 * // Batch — flush at end of request
 * const db = withDrizzleAudit(rawDb, { storage, flushMode: 'batch' })
 * app.use(async (c, next) => { await next(); await db.$flushAudit() })
 * ```
 */
export type FlushMode = "immediate" | "batch";

// --- Main Options ---

/**
 * Configuration options for {@link withDrizzleAudit}.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   tables: [users, orders],
 *   dataMode: 'changes-only',
 *   transform: (entry) => ({ ...entry, metadata: { ...entry.metadata, env: 'prod' } }),
 *   onError: 'warn',
 *   flushMode: 'immediate',
 * })
 * ```
 */
export interface DrizzleAuditOptions {
  /** Storage backend for audit entries */
  storage: AuditStorage;
  /**
   * The audit table itself. When provided, this table is automatically excluded
   * from auditing to prevent infinite recursion when using `drizzleTableStorage`
   * writing to the same database.
   *
   * @example
   * ```ts
   * const auditLog = pgAuditTable()
   * const db = withDrizzleAudit(rawDb, {
   *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
   *   auditTable: auditLog,
   * })
   * ```
   */
  auditTable?: Table;
  /** Which tables to audit. Default: `'all'` */
  tables?: TablesConfig;
  /** What data to store. Default: `'changes-only'` */
  dataMode?: DataMode;
  /** Global transform applied to all entries after per-table transforms */
  transform?: AuditTransform;
  /** Error handling policy. Default: `'warn'` */
  onError?: AuditErrorHandler;
  /** When to write entries to storage. Default: `'immediate'` */
  flushMode?: FlushMode;
}
