import type { AuditStorage, AuditEntry } from "../types.ts";

/**
 * Options for {@link httpStorage}.
 */
export interface HttpStorageOptions {
  /**
   * The endpoint URL that receives audit entries as a JSON `POST` request.
   * The request body is a JSON array of {@link AuditEntry} objects.
   */
  url: string;

  /**
   * Additional HTTP headers to include in every request.
   * Useful for authentication, e.g. `{ "Authorization": "Bearer <token>" }`.
   */
  headers?: Record<string, string>;

  /**
   * Number of times to retry a failed request using exponential back-off
   * (200 ms × 2^attempt). Defaults to `2`.
   */
  retries?: number;

  /**
   * Maximum number of entries to accumulate before flushing immediately.
   * Setting this (or `flushIntervalMs`) enables batching mode.
   * Defaults to `100` when batching is active.
   */
  batchSize?: number;

  /**
   * Interval in milliseconds at which queued entries are flushed automatically.
   * Setting this (or `batchSize`) enables batching mode.
   * Defaults to `1000` ms when batching is active.
   */
  flushIntervalMs?: number;
}

/**
 * An {@link AuditStorage} adapter that POSTs audit entries to an HTTP
 * endpoint as a JSON array.
 *
 * **Immediate mode** (default): every `write` call sends a request right away.
 *
 * **Batching mode**: enabled by setting `batchSize` and/or `flushIntervalMs`.
 * Entries are queued and sent either when the queue reaches `batchSize` or
 * after `flushIntervalMs` milliseconds, whichever comes first. Call `flush()`
 * or `close()` to drain the queue on shutdown.
 *
 * Failed requests are retried with exponential back-off. After all retries are
 * exhausted, a warning is printed and the batch is dropped.
 *
 * @param options - Configuration including `url`, optional headers, retry
 *   count, and batching settings.
 * @returns An {@link AuditStorage} that delivers entries over HTTP.
 *
 * @example
 * ```ts
 * // Immediate delivery
 * import { withDrizzleAudit, httpStorage } from "drizzle-audit";
 *
 * const db = withDrizzleAudit(rawDb, {
 *   storage: httpStorage({
 *     url: "https://audit.example.com/ingest",
 *     headers: { "Authorization": "Bearer my-token" },
 *   }),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Batched delivery — flush on process exit
 * const storage = httpStorage({
 *   url: "https://audit.example.com/ingest",
 *   batchSize: 50,
 *   flushIntervalMs: 5000,
 * });
 *
 * const db = withDrizzleAudit(rawDb, { storage });
 *
 * process.on("beforeExit", () => storage.close?.());
 * ```
 */
export function httpStorage(options: HttpStorageOptions): AuditStorage {
  const { url, headers = {}, retries = 2 } = options;
  const batch = (options.batchSize ?? options.flushIntervalMs) ? true : false;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const batchSize = options.batchSize ?? 100;

  let queue: AuditEntry[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  async function sendWithRetry(entries: AuditEntry[], attempt = 0): Promise<void> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(entries),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
        return sendWithRetry(entries, attempt + 1);
      }
      console.warn("[drizzle-audit] httpStorage failed to deliver batch:", err);
    }
  }

  async function flushQueue(): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue.splice(0);
    await sendWithRetry(batch);
  }

  if (batch) {
    timer = setInterval(flushQueue, flushIntervalMs);
  }

  return {
    async write(entries: AuditEntry[]) {
      if (batch) {
        queue.push(...entries);
        if (queue.length >= batchSize) {
          await flushQueue();
        }
      } else {
        await sendWithRetry(entries);
      }
    },

    async flush() {
      if (timer) clearInterval(timer);
      await flushQueue();
    },

    async close() {
      if (timer) clearInterval(timer);
      await flushQueue();
    },
  };
}
