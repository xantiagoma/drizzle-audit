import type { Table } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { resolveContext } from "./context.ts";
import { buildChanges } from "./diff.ts";
import type {
  AuditEntry,
  AuditStorage,
  AuditErrorHandler,
  TablesConfig,
  DataMode,
  AuditTransform,
  ShouldAuditFn,
  ShouldAuditContext,
} from "./types.ts";

function generateId(): string {
  return crypto.randomUUID();
}

export function getPrimaryKeyColumns(table: Table): string[] {
  const columns = getTableColumns(table);
  const pkColumns: string[] = [];
  for (const [name, column] of Object.entries(columns)) {
    if ((column as any).primary) {
      pkColumns.push(name);
    }
  }
  return pkColumns;
}

export function extractRowId(row: Record<string, unknown>, pkColumns: string[]): string | null {
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

export interface WrapContext {
  tableName: string;
  pkColumns: string[];
  dataMode: DataMode;
  storage: AuditStorage;
  tablesConfig: TablesConfig | undefined;
  transform: AuditTransform | undefined;
  onError: AuditErrorHandler | undefined;
  batch?: { add(entries: AuditEntry[]): void };
  globalShouldAudit?: ShouldAuditFn;
}

/**
 * Check if this operation should be audited based on sampling config.
 * Resolution: per-table shouldAudit → per-table sample → global shouldAudit → true
 */
function checkShouldAudit(wctx: WrapContext, action: string, rowId: string | null): boolean {
  const ctx = resolveContext();
  const shouldAuditCtx: ShouldAuditContext = {
    tableName: wctx.tableName,
    action,
    rowId,
    userId: ctx.userId,
    metadata: ctx.metadata ?? null,
  };

  // Per-table shouldAudit or sample
  if (
    wctx.tablesConfig &&
    typeof wctx.tablesConfig === "object" &&
    !Array.isArray(wctx.tablesConfig) &&
    !("exclude" in wctx.tablesConfig)
  ) {
    const tableConfig = wctx.tablesConfig[wctx.tableName];
    if (tableConfig && tableConfig !== true) {
      if (tableConfig.shouldAudit) return tableConfig.shouldAudit(shouldAuditCtx);
      if (tableConfig.sample !== undefined) return Math.random() < tableConfig.sample;
    }
  }

  // Global shouldAudit
  if (wctx.globalShouldAudit) return wctx.globalShouldAudit(shouldAuditCtx);

  return true;
}

async function writeEntries(ctx: WrapContext, entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // Apply sampling/shouldAudit filter
  const filtered = entries.filter((entry) => checkShouldAudit(ctx, entry.action, entry.rowId));
  if (filtered.length === 0) return;

  if (ctx.batch) {
    ctx.batch.add(filtered);
    return;
  }
  try {
    await ctx.storage.write(filtered);
  } catch (error) {
    const handler = ctx.onError ?? "warn";
    if (handler === "throw") throw error;
    if (handler === "ignore") return;
    if (handler === "warn") {
      console.warn("[drizzle-audit] Failed to write audit entries:", error);
      return;
    }
    handler(error, entries);
  }
}

function applyTransforms(entry: AuditEntry, ctx: WrapContext): AuditEntry {
  let result = entry;
  // Per-table transforms
  if (
    ctx.tablesConfig &&
    typeof ctx.tablesConfig === "object" &&
    !Array.isArray(ctx.tablesConfig) &&
    !("exclude" in ctx.tablesConfig)
  ) {
    const tableConfig = ctx.tablesConfig[ctx.tableName];
    if (tableConfig && tableConfig !== true && tableConfig.transforms) {
      for (const t of tableConfig.transforms) {
        result = t(result);
      }
    }
  }
  // Global transform
  if (ctx.transform) {
    result = ctx.transform(result);
  }
  return result;
}

/** Execution methods that sync SQLite drivers use */
const EXEC_METHODS = ["run", "all", "get", "execute", "then"] as const;

/**
 * Intercepts .then() on a builder to run audit logic after execution.
 * Works for async drivers (PG, libsql, etc.)
 */
function interceptThen(
  target: any,
  auditFn: (result: any) => Promise<void>,
): (onFulfilled: any, onRejected: any) => any {
  return (onFulfilled: any, onRejected: any) => {
    const promise = target.then(async (result: any) => {
      await auditFn(result);
      return result;
    });
    return promise.then(onFulfilled, onRejected);
  };
}

/**
 * Intercepts a sync execution method (.run(), .all(), .get(), .execute())
 * to run audit logic after execution. For sync SQLite drivers.
 */
function interceptSync(
  target: any,
  method: string,
  auditFn: (result: any) => void,
): (...args: any[]) => any {
  return (...args: any[]) => {
    const result = target[method](...args);
    auditFn(result);
    return result;
  };
}

// --- INSERT ---

export function wrapInsertBuilder(builder: any, wctx: WrapContext, db: any, table: Table) {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "values") {
        return (...args: any[]) => {
          const valuesData = args[0]; // capture the values for audit
          const valuesResult = target.values(...args);
          return wrapInsertValues(valuesResult, wctx, db, table, valuesData);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapInsertValues(builder: any, wctx: WrapContext, db: any, table: Table, valuesData: any) {
  let hasReturning = false;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "returning") {
        hasReturning = true;
        return (...retArgs: any[]) => {
          const returningBuilder = target.returning(...retArgs);
          return new Proxy(returningBuilder, {
            get(rTarget, rProp, rReceiver) {
              if (rProp === "then") {
                return interceptThen(rTarget, async (rows) => {
                  const rowArr = Array.isArray(rows) ? rows : [rows];
                  const entries: AuditEntry[] = [];
                  for (const row of rowArr) {
                    const rowId = extractRowId(row, wctx.pkColumns);
                    let entry = buildAuditEntry(
                      "INSERT",
                      wctx.tableName,
                      rowId,
                      null,
                      row,
                      wctx.dataMode,
                    );
                    entry = applyTransforms(entry, wctx);
                    entries.push(entry);
                  }
                  await writeEntries(wctx, entries);
                });
              }
              return Reflect.get(rTarget, rProp, rReceiver);
            },
          });
        };
      }

      // Intercept execution methods when NO .returning()
      if (!hasReturning && (EXEC_METHODS as readonly string[]).includes(prop as string)) {
        const auditFn = () => {
          const rows = Array.isArray(valuesData) ? valuesData : [valuesData];
          const entries: AuditEntry[] = [];
          for (const row of rows) {
            const rowId = extractRowId(row, wctx.pkColumns);
            let entry = buildAuditEntry("INSERT", wctx.tableName, rowId, null, row, wctx.dataMode);
            entry = applyTransforms(entry, wctx);
            entries.push(entry);
          }
          writeEntries(wctx, entries);
        };

        if (prop === "then") {
          return interceptThen(target, async () => auditFn());
        }
        return interceptSync(target, prop as string, auditFn);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

// --- UPDATE ---

export function wrapUpdateBuilder(builder: any, wctx: WrapContext, db: any, table: Table) {
  let whereClause: any = null;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "set") {
        return (data: any) => {
          const setResult = target.set(data);
          return wrapUpdateSet(
            setResult,
            wctx,
            db,
            table,
            () => whereClause,
            (w: any) => {
              whereClause = w;
            },
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapUpdateSet(
  builder: any,
  wctx: WrapContext,
  db: any,
  table: Table,
  getWhere: () => any,
  setWhere: (w: any) => void,
) {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "where") {
        return (...whereArgs: any[]) => {
          setWhere(whereArgs[0]);
          const whereResult = target.where(...whereArgs);
          return wrapUpdateWhere(whereResult, wctx, db, table, getWhere);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapUpdateWhere(
  builder: any,
  wctx: WrapContext,
  db: any,
  table: Table,
  getWhere: () => any,
) {
  let hasReturning = false;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "returning") {
        hasReturning = true;
        return (...retArgs: any[]) => {
          const returningBuilder = target.returning(...retArgs);
          return new Proxy(returningBuilder, {
            get(rTarget, rProp, rReceiver) {
              if (rProp === "then") {
                const whereClause = getWhere();
                return (onFulfilled: any, onRejected: any) => {
                  // SELECT old data BEFORE the update executes
                  const oldDataPromise = whereClause
                    ? db.select().from(table).where(whereClause)
                    : Promise.resolve([]);

                  const promise = oldDataPromise.then(async (oldRows: any[]) => {
                    const newRows = await rTarget;
                    const newRowArr = Array.isArray(newRows) ? newRows : [newRows];
                    const entries: AuditEntry[] = [];

                    for (let i = 0; i < newRowArr.length; i++) {
                      const newRow = newRowArr[i];
                      const oldRow = oldRows[i] ?? null;
                      const rowId = extractRowId(newRow, wctx.pkColumns);
                      let entry = buildAuditEntry(
                        "UPDATE",
                        wctx.tableName,
                        rowId,
                        oldRow,
                        newRow,
                        wctx.dataMode,
                      );
                      if (!entry.changes && !entry.oldData && !entry.newData) continue;
                      entry = applyTransforms(entry, wctx);
                      entries.push(entry);
                    }

                    await writeEntries(wctx, entries);
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

      // Without .returning() — intercept execution (sync or async)
      if (
        !hasReturning &&
        (EXEC_METHODS as readonly string[]).includes(prop as string) &&
        prop !== "then"
      ) {
        const whereClause = getWhere();
        return (...args: any[]) => {
          const oldRows = whereClause ? db.select().from(table).where(whereClause).all() : [];
          const result = target[prop](...args);
          const newRows = whereClause ? db.select().from(table).where(whereClause).all() : [];

          const entries: AuditEntry[] = [];
          const maxLen = Math.max(oldRows.length, newRows.length);
          for (let i = 0; i < maxLen; i++) {
            const oldRow = oldRows[i] ?? null;
            const newRow = newRows[i] ?? null;
            const rowId = extractRowId(newRow ?? oldRow, wctx.pkColumns);
            let entry = buildAuditEntry(
              "UPDATE",
              wctx.tableName,
              rowId,
              oldRow,
              newRow,
              wctx.dataMode,
            );
            if (!entry.changes && !entry.oldData && !entry.newData) continue;
            entry = applyTransforms(entry, wctx);
            entries.push(entry);
          }
          writeEntries(wctx, entries);
          return result;
        };
      }

      // Async path (.then())
      if (prop === "then" && !hasReturning) {
        const whereClause = getWhere();
        return (onFulfilled: any, onRejected: any) => {
          const oldDataPromise = whereClause
            ? db.select().from(table).where(whereClause)
            : Promise.resolve([]);

          const promise = oldDataPromise.then(async (oldRows: any[]) => {
            const result = await target; // execute the UPDATE

            // SELECT after to get new state
            const newRows = whereClause ? await db.select().from(table).where(whereClause) : [];

            const entries: AuditEntry[] = [];
            const maxLen = Math.max(oldRows.length, newRows.length);
            for (let i = 0; i < maxLen; i++) {
              const oldRow = oldRows[i] ?? null;
              const newRow = newRows[i] ?? null;
              const rowId = extractRowId(newRow ?? oldRow, wctx.pkColumns);
              let entry = buildAuditEntry(
                "UPDATE",
                wctx.tableName,
                rowId,
                oldRow,
                newRow,
                wctx.dataMode,
              );
              if (!entry.changes && !entry.oldData && !entry.newData) continue;
              entry = applyTransforms(entry, wctx);
              entries.push(entry);
            }

            await writeEntries(wctx, entries);
            return result;
          });

          return promise.then(onFulfilled, onRejected);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

// --- DELETE ---

export function wrapDeleteBuilder(builder: any, wctx: WrapContext, db: any, table: Table) {
  let whereClause: any = null;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "where") {
        return (...whereArgs: any[]) => {
          whereClause = whereArgs[0];
          const whereResult = target.where(...whereArgs);
          return wrapDeleteWhere(whereResult, wctx, db, table, () => whereClause);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapDeleteWhere(
  builder: any,
  wctx: WrapContext,
  db: any,
  table: Table,
  getWhere: () => any,
) {
  let hasReturning = false;

  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "returning") {
        hasReturning = true;
        return (...retArgs: any[]) => {
          const returningBuilder = target.returning(...retArgs);
          return new Proxy(returningBuilder, {
            get(rTarget, rProp, rReceiver) {
              if (rProp === "then") {
                const whereClause = getWhere();
                return (onFulfilled: any, onRejected: any) => {
                  // SELECT old data BEFORE delete executes
                  const oldDataPromise = whereClause
                    ? db.select().from(table).where(whereClause)
                    : Promise.resolve([]);

                  const promise = oldDataPromise.then(async (oldRows: any[]) => {
                    const deletedRows = await rTarget;
                    const entries: AuditEntry[] = [];
                    for (const oldRow of oldRows) {
                      const rowId = extractRowId(oldRow, wctx.pkColumns);
                      let entry = buildAuditEntry(
                        "DELETE",
                        wctx.tableName,
                        rowId,
                        oldRow,
                        null,
                        wctx.dataMode,
                      );
                      entry = applyTransforms(entry, wctx);
                      entries.push(entry);
                    }
                    await writeEntries(wctx, entries);
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

      // Without .returning() — sync execution
      if (
        !hasReturning &&
        (EXEC_METHODS as readonly string[]).includes(prop as string) &&
        prop !== "then"
      ) {
        const whereClause = getWhere();
        return (...args: any[]) => {
          const oldRows = whereClause ? db.select().from(table).where(whereClause).all() : [];
          const result = target[prop](...args);
          const entries: AuditEntry[] = [];
          for (const oldRow of oldRows) {
            const rowId = extractRowId(oldRow, wctx.pkColumns);
            let entry = buildAuditEntry(
              "DELETE",
              wctx.tableName,
              rowId,
              oldRow,
              null,
              wctx.dataMode,
            );
            entry = applyTransforms(entry, wctx);
            entries.push(entry);
          }
          writeEntries(wctx, entries);
          return result;
        };
      }

      // Async path (.then())
      if (prop === "then" && !hasReturning) {
        const whereClause = getWhere();
        return (onFulfilled: any, onRejected: any) => {
          const oldDataPromise = whereClause
            ? db.select().from(table).where(whereClause)
            : Promise.resolve([]);

          const promise = oldDataPromise.then(async (oldRows: any[]) => {
            const result = await target;
            const entries: AuditEntry[] = [];
            for (const oldRow of oldRows) {
              const rowId = extractRowId(oldRow, wctx.pkColumns);
              let entry = buildAuditEntry(
                "DELETE",
                wctx.tableName,
                rowId,
                oldRow,
                null,
                wctx.dataMode,
              );
              entry = applyTransforms(entry, wctx);
              entries.push(entry);
            }
            await writeEntries(wctx, entries);
            return result;
          });

          return promise.then(onFulfilled, onRejected);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}
