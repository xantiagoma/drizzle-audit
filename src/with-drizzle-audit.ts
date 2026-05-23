import { getTableName, getTableColumns, type Table } from "drizzle-orm";
import {
  resolveContext,
  useDrizzleAuditContext,
  withDrizzleAuditContext,
  newDrizzleAuditContext,
  addDrizzleAuditMetadata,
} from "./context.ts";
import { buildChanges } from "./diff.ts";
import { _setGlobalStorage } from "./audit-action-internal.ts";
import { drizzleAuditAction } from "./audit-action.ts";
import { trackAction } from "./track-action.ts";
import { _withTxDb } from "./storage/drizzle.ts";
import type {
  DrizzleAuditOptions,
  DrizzleAuditContext,
  AuditEntry,
  AuditStorage,
  AuditErrorHandler,
  TablesConfig,
  TableAuditConfig,
  DataMode,
  AuditTransform,
} from "./types.ts";

function generateId(): string {
  return crypto.randomUUID();
}

function handleError(
  onError: AuditErrorHandler | undefined,
  error: unknown,
  entries: AuditEntry[],
): void {
  const handler = onError ?? "warn";
  if (handler === "throw") throw error;
  if (handler === "ignore") return;
  if (handler === "warn") {
    console.warn("[drizzle-audit] Failed to write audit entries:", error);
    return;
  }
  handler(error, entries);
}

function shouldAuditTable(
  tableName: string,
  config: TablesConfig | undefined,
  excludedTables?: Set<string>,
): boolean {
  // Always exclude tables in the exclusion set (e.g. the audit table itself)
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

function getTableConfig(
  tableName: string,
  config: TablesConfig | undefined,
): TableAuditConfig | null {
  if (!config || config === "all" || Array.isArray(config) || "exclude" in config) {
    return null;
  }
  const entry = config[tableName];
  if (!entry || entry === true) return null;
  return entry;
}

function getDataMode(
  tableName: string,
  globalMode: DataMode | undefined,
  tablesConfig: TablesConfig | undefined,
): DataMode {
  const tableConfig = getTableConfig(tableName, tablesConfig);
  return tableConfig?.dataMode ?? globalMode ?? "changes-only";
}

function applyTransforms(
  entry: AuditEntry,
  tableName: string,
  tablesConfig: TablesConfig | undefined,
  globalTransform: AuditTransform | undefined,
): AuditEntry {
  let result = entry;
  const tableConfig = getTableConfig(tableName, tablesConfig);
  if (tableConfig?.transforms) {
    for (const transform of tableConfig.transforms) {
      result = transform(result);
    }
  }
  if (globalTransform) {
    result = globalTransform(result);
  }
  return result;
}

function getPrimaryKeyColumns(table: Table): string[] {
  const columns = getTableColumns(table);
  const pkColumns: string[] = [];
  for (const [name, column] of Object.entries(columns)) {
    if ((column as any).primary) {
      pkColumns.push(name);
    }
  }
  return pkColumns;
}

function extractRowId(row: Record<string, unknown>, pkColumns: string[]): string | null {
  if (pkColumns.length === 0) return null;
  if (pkColumns.length === 1) {
    const val = row[pkColumns[0]!];
    return val != null ? String(val) : null;
  }
  const composite: Record<string, unknown> = {};
  for (const col of pkColumns) {
    composite[col] = row[col];
  }
  return JSON.stringify(composite);
}

function buildAuditEntry(
  action: string,
  tableName: string,
  rowId: string | null,
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  dataMode: DataMode,
): AuditEntry {
  const ctx = resolveContext();
  const changes = buildChanges(action, oldData, newData);

  return {
    id: generateId(),
    tableName,
    action,
    rowId,
    changes: dataMode === "full-snapshots" ? null : changes,
    oldData: dataMode === "changes-only" ? null : oldData,
    newData: dataMode === "changes-only" ? null : newData,
    timestamp: new Date(),
    userId: ctx.userId,
    metadata: ctx.metadata ?? null,
  };
}

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
        handleError(onError, error, batch);
      }
    },
    get pending() {
      return buffer.length;
    },
  };
}

async function writeAuditEntries(
  storage: AuditStorage,
  entries: AuditEntry[],
  onError: AuditErrorHandler | undefined,
  batch?: ReturnType<typeof createBatchBuffer>,
): Promise<void> {
  if (entries.length === 0) return;
  if (batch) {
    batch.add(entries);
    return;
  }
  try {
    await storage.write(entries);
  } catch (error) {
    handleError(onError, error, entries);
  }
}

/**
 * The `$audit` namespace available on a Drizzle db instance wrapped by
 * {@link withDrizzleAudit}. Provides access to all audit functionality
 * directly from the db object — no extra imports needed.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, { storage });
 *
 * // Custom action
 * await db.$audit.action({ action: "VIEW_PII", tableName: "users", rowId: "42" });
 *
 * // Scoped tracking
 * { using t = db.$audit.track({ action: "PROCESS_ORDER" }); }
 *
 * // Context
 * await db.$audit.withContext({ userId: "u_1" }, async () => { ... });
 * const ctx = db.$audit.context();
 *
 * // Batch flush
 * await db.$audit.flush();
 * console.log(db.$audit.pending); // 0
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
   * await db.$audit.action({ action: "LOGIN_FAILED", userId: email, metadata: { ip } });
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
   * userId is overridden if provided, metadata is shallow-merged.
   *
   * @example
   * ```ts
   * // Outer: { userId: "admin", metadata: { ip: "1.2.3.4" } }
   * await db.$audit.withContext({ metadata: { operation: "edit" } }, async () => {
   *   // Inner: { userId: "admin", metadata: { ip: "1.2.3.4", operation: "edit" } }
   * });
   * ```
   */
  withContext<T>(context: Partial<DrizzleAuditContext>, fn: () => Promise<T>): Promise<T>;
  /**
   * Run a function with a **fresh** audit context, ignoring any existing context.
   * Use when you don't want to inherit the current context (e.g. system actions).
   *
   * @example
   * ```ts
   * await db.$audit.newContext({ userId: null, metadata: { trigger: "system" } }, async () => {
   *   // Clean context — nothing from the outer scope leaks in
   * });
   * ```
   */
  newContext<T>(context: DrizzleAuditContext, fn: () => Promise<T>): Promise<T>;
  /** Get the current audit context, or `null` if none is active. */
  context(): DrizzleAuditContext | null;
  /** Merge metadata into the current audit context. */
  addMetadata(metadata: Record<string, unknown>): void;
}

/**
 * Properties added to the Drizzle db instance by {@link withDrizzleAudit}.
 *
 * @example
 * ```ts
 * const db = withDrizzleAudit(rawDb, { storage });
 *
 * // All audit features via db.$audit
 * // Via namespace
 * await db.$audit.action({ action: "VIEW_PII" });
 * await db.$audit.flush();
 *
 * // Via shortcuts
 * await db.$flushAudit();
 * console.log(db.$pendingAuditEntries);
 * ```
 */
export interface AuditedDb {
  /** All audit functionality in one namespace */
  readonly $audit: AuditNamespace;
  /** Shortcut for `db.$audit.flush()` */
  $flushAudit(): Promise<void>;
  /** Shortcut for `db.$audit.pending` */
  readonly $pendingAuditEntries: number;
}

/**
 * Wraps a Drizzle ORM database instance with automatic audit logging.
 *
 * Returns a `Proxy` of the original `db` that intercepts `insert`, `update`,
 * and `delete` operations. When `.returning()` is chained, audit entries are
 * written to `options.storage` after the query resolves. The proxy also
 * registers the storage globally so that {@link drizzleAuditAction} and
 * {@link trackAction} can use it without an explicit `storage` argument.
 *
 * Transaction support: wrapping a transaction callback with `db.transaction()`
 * automatically re-wraps the `tx` instance so audit writes inside the
 * transaction use the same connection, preventing deadlocks on
 * single-connection databases (PGlite, SQLite).
 *
 * @param db - The raw Drizzle database instance to wrap.
 * @param options - Audit configuration (storage, table selection, data mode, etc.).
 * @returns The same `db` instance augmented with {@link AuditedDb} helpers.
 *
 * @example
 * ```ts
 * import { drizzle } from "drizzle-orm/bun-sqlite";
 * import { drizzleTableStorage } from "drizzle-audit/storage";
 * import { withDrizzleAudit } from "drizzle-audit";
 * import { auditLog } from "./schema";
 *
 * const rawDb = drizzle(new Database("db.sqlite"));
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: drizzleTableStorage(auditLog, { db: rawDb }),
 *   tables: [users, orders],
 *   dataMode: "changes-only",
 *   onError: "warn",
 * });
 *
 * // Audit entry is written automatically
 * const [user] = await db.insert(users).values({ name: "Alice" }).returning();
 * ```
 *
 * @example
 * ```ts
 * // Batch flush mode — accumulate entries and write once per request
 * const db = withDrizzleAudit(rawDb, {
 *   storage,
 *   flushMode: "batch",
 * });
 *
 * app.use(async (c, next) => {
 *   await next();
 *   await db.$flushAudit();
 * });
 * ```
 */
export function withDrizzleAudit<Q>(db: Q, options: DrizzleAuditOptions): Q & AuditedDb {
  // Register global storage so drizzleAuditAction() and trackAction() can use it
  _setGlobalStorage(options.storage, options.onError);
  return _wrapDbProxy(db, options) as Q & AuditedDb;
}

function _wrapDbProxy<Q>(db: Q, options: DrizzleAuditOptions): Q {
  const { storage, tables: tablesConfig, dataMode: globalDataMode, transform, onError } = options;
  const flushMode = options.flushMode ?? "immediate";
  const batch = flushMode === "batch" ? createBatchBuffer(storage, onError) : undefined;

  // Build set of table names to always exclude (e.g. the audit table itself)
  const excludedTables = new Set<string>();
  if (options.auditTable) {
    excludedTables.add(getTableName(options.auditTable));
  }

  const typedDb = db as any;

  // Build the $audit namespace object (created once, reused)
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
      if (prop === "$audit") {
        return auditNamespace;
      }
      // Legacy shortcuts
      if (prop === "$flushAudit") {
        return auditNamespace.flush;
      }
      if (prop === "$pendingAuditEntries") {
        return auditNamespace.pending;
      }

      if (prop === "insert") {
        return (table: Table) => {
          const tableName = getTableName(table);
          const builder = target.insert(table);

          if (!shouldAuditTable(tableName, tablesConfig, excludedTables)) {
            return builder;
          }

          const pkColumns = getPrimaryKeyColumns(table);
          const dataMode = getDataMode(tableName, globalDataMode, tablesConfig);

          return wrapInsertBuilder(
            builder,
            tableName,
            pkColumns,
            dataMode,
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
          );
        };
      }

      if (prop === "update") {
        return (table: Table) => {
          const tableName = getTableName(table);

          if (!shouldAuditTable(tableName, tablesConfig, excludedTables)) {
            return target.update(table);
          }

          const pkColumns = getPrimaryKeyColumns(table);
          const dataMode = getDataMode(tableName, globalDataMode, tablesConfig);

          return wrapUpdateBuilder(
            target,
            table,
            tableName,
            pkColumns,
            dataMode,
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
          );
        };
      }

      if (prop === "delete") {
        return (table: Table) => {
          const tableName = getTableName(table);

          if (!shouldAuditTable(tableName, tablesConfig, excludedTables)) {
            return target.delete(table);
          }

          const pkColumns = getPrimaryKeyColumns(table);
          const dataMode = getDataMode(tableName, globalDataMode, tablesConfig);

          return wrapDeleteBuilder(
            target,
            table,
            tableName,
            pkColumns,
            dataMode,
            storage,
            tablesConfig,
            transform,
            onError,
            batch,
          );
        };
      }

      if (prop === "transaction") {
        const originalTransaction = target.transaction;
        if (!originalTransaction) return undefined;
        return (fn: any, config?: any) => {
          return originalTransaction.call(
            target,
            (tx: any) => {
              // Wrap the tx with audit interception, but DON'T re-register global storage
              const auditedTx = _wrapDbProxy(tx, options);
              // Run the callback with tx as the db override for drizzleTableStorage
              // This prevents deadlocks on single-connection DBs (PGlite, SQLite)
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

function wrapInsertBuilder(
  builder: any,
  tableName: string,
  pkColumns: string[],
  dataMode: DataMode,
  storage: AuditStorage,
  tablesConfig: TablesConfig | undefined,
  transform: AuditTransform | undefined,
  onError: AuditErrorHandler | undefined,
  batch?: ReturnType<typeof createBatchBuffer>,
) {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "values") {
        return (...args: any[]) => {
          const valuesResult = target.values(...args);

          return new Proxy(valuesResult, {
            get(vTarget, vProp, vReceiver) {
              if (vProp === "returning") {
                return (...retArgs: any[]) => {
                  const returningBuilder = vTarget.returning(...retArgs);

                  return new Proxy(returningBuilder, {
                    get(rTarget, rProp, rReceiver) {
                      if (rProp === "then") {
                        return (onFulfilled: any, onRejected: any) => {
                          const promise = rTarget.then(async (rows: any) => {
                            const rowArr = Array.isArray(rows) ? rows : [rows];
                            const entries: AuditEntry[] = [];

                            for (const row of rowArr) {
                              const rowId = extractRowId(row, pkColumns);
                              let entry = buildAuditEntry(
                                "INSERT",
                                tableName,
                                rowId,
                                null,
                                row as Record<string, unknown>,
                                dataMode,
                              );
                              entry = applyTransforms(entry, tableName, tablesConfig, transform);
                              entries.push(entry);
                            }

                            await writeAuditEntries(storage, entries, onError, batch);
                            return rows;
                          });

                          return promise.then(onFulfilled, onRejected);
                        };
                      }
                      return Reflect.get(rTarget, rProp, rReceiver);
                    },
                  });
                };
              }
              return Reflect.get(vTarget, vProp, vReceiver);
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapUpdateBuilder(
  db: any,
  table: Table,
  tableName: string,
  pkColumns: string[],
  dataMode: DataMode,
  storage: AuditStorage,
  tablesConfig: TablesConfig | undefined,
  transform: AuditTransform | undefined,
  onError: AuditErrorHandler | undefined,
  batch?: ReturnType<typeof createBatchBuffer>,
) {
  const builder = db.update(table);
  let whereClause: any = null;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return (data: any) => {
          const setResult = target.set(data);

          return new Proxy(setResult, {
            get(sTarget, sProp, sReceiver) {
              if (sProp === "where") {
                return (...whereArgs: any[]) => {
                  whereClause = whereArgs[0];
                  const whereResult = sTarget.where(...whereArgs);

                  return new Proxy(whereResult, {
                    get(wTarget, wProp, wReceiver) {
                      if (wProp === "returning") {
                        return (...retArgs: any[]) => {
                          const returningBuilder = wTarget.returning(...retArgs);

                          return new Proxy(returningBuilder, {
                            get(rTarget, rProp, rReceiver) {
                              if (rProp === "then") {
                                return (onFulfilled: any, onRejected: any) => {
                                  // First, get old data
                                  const oldDataPromise = db.select().from(table).where(whereClause);

                                  const promise = oldDataPromise.then(async (oldRows: any[]) => {
                                    const newRows = await rTarget;
                                    const newRowArr = Array.isArray(newRows) ? newRows : [newRows];
                                    const entries: AuditEntry[] = [];

                                    for (let i = 0; i < newRowArr.length; i++) {
                                      const newRow = newRowArr[i];
                                      const oldRow = oldRows[i] ?? null;
                                      const rowId = extractRowId(newRow, pkColumns);

                                      let entry = buildAuditEntry(
                                        "UPDATE",
                                        tableName,
                                        rowId,
                                        oldRow,
                                        newRow as Record<string, unknown>,
                                        dataMode,
                                      );

                                      // Skip no-op updates (nothing actually changed)
                                      if (!entry.changes && !entry.oldData && !entry.newData)
                                        continue;

                                      entry = applyTransforms(
                                        entry,
                                        tableName,
                                        tablesConfig,
                                        transform,
                                      );
                                      entries.push(entry);
                                    }

                                    await writeAuditEntries(storage, entries, onError, batch);
                                    return newRows;
                                  });

                                  return promise.then(onFulfilled, onRejected);
                                };
                              }
                              return Reflect.get(rTarget, rProp, rReceiver);
                            },
                          });
                        };
                      }
                      return Reflect.get(wTarget, wProp, wReceiver);
                    },
                  });
                };
              }
              return Reflect.get(sTarget, sProp, sReceiver);
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapDeleteBuilder(
  db: any,
  table: Table,
  tableName: string,
  pkColumns: string[],
  dataMode: DataMode,
  storage: AuditStorage,
  tablesConfig: TablesConfig | undefined,
  transform: AuditTransform | undefined,
  onError: AuditErrorHandler | undefined,
  batch?: ReturnType<typeof createBatchBuffer>,
) {
  const builder = db.delete(table);

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "where") {
        return (...whereArgs: any[]) => {
          const whereClause = whereArgs[0];
          const whereResult = target.where(...whereArgs);

          return new Proxy(whereResult, {
            get(wTarget, wProp, wReceiver) {
              if (wProp === "returning") {
                return (...retArgs: any[]) => {
                  const returningBuilder = wTarget.returning(...retArgs);

                  return new Proxy(returningBuilder, {
                    get(rTarget, rProp, rReceiver) {
                      if (rProp === "then") {
                        return (onFulfilled: any, onRejected: any) => {
                          // Get old data before delete executes
                          const oldDataPromise = db.select().from(table).where(whereClause);

                          const promise = oldDataPromise.then(async (oldRows: any[]) => {
                            const deletedRows = await rTarget;
                            const entries: AuditEntry[] = [];

                            for (const oldRow of oldRows) {
                              const rowId = extractRowId(oldRow, pkColumns);
                              let entry = buildAuditEntry(
                                "DELETE",
                                tableName,
                                rowId,
                                oldRow as Record<string, unknown>,
                                null,
                                dataMode,
                              );
                              entry = applyTransforms(entry, tableName, tablesConfig, transform);
                              entries.push(entry);
                            }

                            await writeAuditEntries(storage, entries, onError, batch);
                            return deletedRows;
                          });

                          return promise.then(onFulfilled, onRejected);
                        };
                      }
                      return Reflect.get(rTarget, rProp, rReceiver);
                    },
                  });
                };
              }
              return Reflect.get(wTarget, wProp, wReceiver);
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
