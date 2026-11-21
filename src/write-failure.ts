import type { AuditEntry, AuditErrorHandler, AuditStorage } from "./types.ts";

/**
 * Handle a failed `storage.write(entries)`: first salvage the entries into `fallbackStorage`
 * (when configured), then apply the `onError` policy exactly as without a fallback.
 *
 * - The original error is what `onError` sees, unless the fallback write fails too: then it
 *   gets an `AggregateError` of `[storageError, fallbackError]`.
 * - With `"warn"` the message says when the entries were saved to the fallback.
 *
 * @param message - Warning prefix, e.g. `"Failed to write audit entries"`.
 * @internal
 */
export async function handleWriteFailure(
  error: unknown,
  entries: AuditEntry[],
  onError: AuditErrorHandler | undefined,
  fallbackStorage: AuditStorage | undefined,
  message: string,
): Promise<void> {
  let reported = error;
  let saved = false;
  if (fallbackStorage) {
    try {
      await fallbackStorage.write(entries);
      saved = true;
    } catch (fallbackError) {
      reported = new AggregateError(
        [error, fallbackError],
        `[drizzle-audit] ${message}, and fallbackStorage failed too`,
      );
    }
  }

  const handler = onError ?? "warn";
  if (handler === "throw") throw reported;
  if (handler === "ignore") return;
  if (handler === "warn") {
    const suffix = saved ? " (entries written to fallbackStorage)" : "";
    console.warn(`[drizzle-audit] ${message}${suffix}:`, reported);
    return;
  }
  handler(reported, entries);
}
