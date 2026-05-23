import { getTableName, type Table } from "drizzle-orm";
import {
  useDrizzleAuditContext,
  withDrizzleAuditContext,
  newDrizzleAuditContext,
  addDrizzleAuditMetadata,
  _setMetadataMerge,
} from "./context.ts";
import { _setGlobalStorage } from "./audit-action-internal.ts";
import { _setComputeChanges } from "./diff.ts";
import { drizzleAuditAction } from "./audit-action.ts";
import { trackAction } from "./track-action.ts";
import { _withTxDb } from "./storage/drizzle.ts";
import {
  wrapInsertBuilder,
  wrapUpdateBuilder,
  wrapDeleteBuilder,
  getPrimaryKeyColumns,
  type WrapContext,
} from "./wrap-builders.ts";
import type {
  DrizzleAuditOptions,
  DrizzleAuditContext,
  AuditEntry,
  AuditStorage,
  AuditErrorHandler,
  TablesConfig,
  DataMode,
} from "./types.ts";

// --- Table config helpers ---

function shouldAuditTable(
  tableName: string,
  config: TablesConfig | undefined,
  excludedTables?: Set<string>,
): boolean {
  if (excludedTables?.has(tableName)) return false;
  if (!config || config === "all") return true;
  if (Array.isArray(config)) {
    return config.some((t) => getTableName(t) === tableName);
  }
  if ("exclude" in config && Array.isArray((config as { exclude: Table[] }).exclude)) {
    return !(config as { exclude: Table[] }).exclude.some((t) => getTableName(t) === tableName);
  }
  return tableName in config;
}

function getDataMode(
  tableName: string,
  globalMode: DataMode | undefined,
  tablesConfig: TablesConfig | undefined,
): DataMode {
  if (
    tablesConfig &&
    typeof tablesConfig === "object" &&
    !Array.isArray(tablesConfig) &&
    !("exclude" in tablesConfig)
  ) {
    const entry = tablesConfig[tableName];
    if (entry && entry !== true && entry.dataMode) {
      return entry.dataMode;
    }
  }
  return globalMode ?? "changes-only";
}

// --- Batch buffer ---

function createBatchBuffer(storage: AuditStorage, onError: AuditErrorHandler | undefined) {
  let buffer: AuditEntry[] = [];
  return {
    add(entries: AuditEntry[]) {
      buffer.push(...entries);
    },
    async flush() {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      try {
        await storage.write(batch);
      } catch (error) {
        const handler = onError ?? "warn";
        if (handler === "throw") throw error;
        if (handler === "ignore") return;
        if (handler === "warn") {
          console.warn("[drizzle-audit] Failed to write audit entries:", error);
          return;
        }
        handler(error, batch);
      }
    },
    get pending() {
      return buffer.length;
    },
  };
}

// --- Types ---

/**
 * The `$audit` namespace available on a Drizzle db instance wrapped by
 * {@link withDrizzleAudit}. Provides access to all audit functionality
 * directly from the db object — no extra imports needed.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, { storage });
 *
 * await db.$audit.action({ action: "VIEW_PII", tableName: "users", rowId: "42" });
 * { using t = db.$audit.track({ action: "PROCESS_ORDER" }); }
 * await db.$audit.withContext({ userId: "u_1" }, async () => { ... });
 * await db.$audit.flush();
 * ```
 */
export interface AuditNamespace {
  /** Flush all buffered audit entries to storage. No-op in `"immediate"` mode. */
  flush(): Promise<void>;
  /** Number of buffered entries not yet written. Always `0` in `"immediate"` mode. */
  readonly pending: number;
  /**
   * Log a custom (non-DB) audit entry. Can be awaited or fire-and-forget.
   *
   * @example
   * ```ts
   * await db.$audit.action({ action: "LOGIN_FAILED", userId: email });
   * db.$audit.action({ action: "VIEW_PII", tableName: "users", rowId: "42" }); // fire-and-forget
   * ```
   */
  action(options: import("./audit-action.ts").DrizzleAuditActionOptions): Promise<void>;
  /**
   * Start a scoped action tracker. Use with `using` or `await using`.
   *
   * @example
   * ```ts
   * { using t = db.$audit.track({ action: "PROCESS" }); t.addMetadata({ step: 1 }); }
   * { await using t = db.$audit.track({ action: "BULK_OP" }); }
   * ```
   */
  track(
    options: import("./track-action.ts").TrackActionOptions,
  ): import("./track-action.ts").ActionTracker;
  /**
   * Run a function with audit context, **merging** with any existing context.
   * userId is overridden if provided, metadata is deep merged.
   *
   * @example
   * ```ts
   * await db.$audit.withContext({ metadata: { operation: "edit" } }, async () => { ... });
   * ```
   */
  withContext<T>(context: Partial<DrizzleAuditContext>, fn: () => Promise<T>): Promise<T>;
  /**
   * Run a function with a **fresh** audit context, ignoring any existing context.
   *
   * @example
   * ```ts
   * await db.$audit.newContext({ userId: null, metadata: { trigger: "system" } }, async () => { ... });
   * ```
   */
  newContext<T>(context: DrizzleAuditContext, fn: () => Promise<T>): Promise<T>;
  /** Get the current audit context, or `null` if none is active. */
  context(): DrizzleAuditContext | null;
  /** Merge metadata into the current audit context (deep merge). */
  addMetadata(metadata: Record<string, unknown>): void;
}

/**
 * Properties added to the Drizzle db instance by {@link withDrizzleAudit}.
 */
export interface AuditedDb {
  /** All audit functionality in one namespace */
  readonly $audit: AuditNamespace;
  /** Shortcut for `db.$audit.flush()` */
  $flushAudit(): Promise<void>;
  /** Shortcut for `db.$audit.pending` */
  readonly $pendingAuditEntries: number;
}

// --- Main ---

/**
 * Wraps a Drizzle ORM database instance with automatic audit logging.
 *
 * Intercepts `insert`, `update`, and `delete` operations — both with and
 * without `.returning()`. Audit entries are written to `options.storage`.
 *
 * @param db - The raw Drizzle database instance to wrap.
 * @param options - Audit configuration.
 * @returns The same `db` instance augmented with {@link AuditedDb} helpers.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   auditTable: auditLog,
 * });
 *
 * // All of these are audited:
 * await db.insert(users).values({ name: "Alice" }).returning();  // with returning
 * await db.insert(users).values({ name: "Bob" });                 // without returning
 * await db.update(users).set({ name: "X" }).where(eq(users.id, 1)); // without returning
 * await db.delete(users).where(eq(users.id, 1));                    // without returning
 * ```
 */
export function withDrizzleAudit<Q>(db: Q, options: DrizzleAuditOptions): Q & AuditedDb {
  _setGlobalStorage(options.storage, options.onError);
  _setMetadataMerge(options.metadataMerge);
  _setComputeChanges(options.computeChanges);
  return _wrapDbProxy(db, options) as Q & AuditedDb;
}

function _wrapDbProxy<Q>(db: Q, options: DrizzleAuditOptions): Q {
  const {
    storage,
    tables: tablesConfig,
    dataMode: globalDataMode,
    transform,
    onError,
    shouldAudit: globalShouldAudit,
  } = options;
  const flushMode = options.flushMode ?? "immediate";
  const batch = flushMode === "batch" ? createBatchBuffer(storage, onError) : undefined;

  const excludedTables = new Set<string>();
  if (options.auditTable) {
    excludedTables.add(getTableName(options.auditTable));
  }

  const typedDb = db as any;

  const auditNamespace: AuditNamespace = {
    flush: async () => {
      if (batch) await batch.flush();
    },
    get pending() {
      return batch?.pending ?? 0;
    },
    action: (opts) => drizzleAuditAction(opts, storage),
    track: (opts) => trackAction(opts, storage),
    withContext: withDrizzleAuditContext,
    newContext: newDrizzleAuditContext,
    context: useDrizzleAuditContext,
    addMetadata: addDrizzleAuditMetadata,
  };

  return new Proxy(typedDb, {
    get(target, prop, receiver) {
      if (prop === "$audit") return auditNamespace;
      if (prop === "$flushAudit") return auditNamespace.flush;
      if (prop === "$pendingAuditEntries") return auditNamespace.pending;

      if (prop === "insert") {
        return (table: Table) => {
          const tableName = getTableName(table);
          const builder = target.insert(table);
          if (!shouldAuditTable(tableName, tablesConfig, excludedTables)) return builder;

          const wctx: WrapContext = {
            tableName,
            pkColumns: getPrimaryKeyColumns(table),
            dataMode: getDataMode(tableName, globalDataMode, tablesConfig),
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
            globalShouldAudit,
          };
          return wrapInsertBuilder(builder, wctx, target, table);
        };
      }

      if (prop === "update") {
        return (table: Table) => {
          const tableName = getTableName(table);
          if (!shouldAuditTable(tableName, tablesConfig, excludedTables))
            return target.update(table);

          const wctx: WrapContext = {
            tableName,
            pkColumns: getPrimaryKeyColumns(table),
            dataMode: getDataMode(tableName, globalDataMode, tablesConfig),
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
            globalShouldAudit,
          };
          return wrapUpdateBuilder(target.update(table), wctx, target, table);
        };
      }

      if (prop === "delete") {
        return (table: Table) => {
          const tableName = getTableName(table);
          if (!shouldAuditTable(tableName, tablesConfig, excludedTables))
            return target.delete(table);

          const wctx: WrapContext = {
            tableName,
            pkColumns: getPrimaryKeyColumns(table),
            dataMode: getDataMode(tableName, globalDataMode, tablesConfig),
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
            globalShouldAudit,
          };
          return wrapDeleteBuilder(target.delete(table), wctx, target, table);
        };
      }

      if (prop === "transaction") {
        const originalTransaction = target.transaction;
        if (!originalTransaction) return undefined;
        return (fn: any, config?: any) => {
          return originalTransaction.call(
            target,
            (tx: any) => {
              const auditedTx = _wrapDbProxy(tx, options);
              return _withTxDb(tx, () => fn(auditedTx));
            },
            config,
          );
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as Q;
}
