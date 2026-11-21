import type { AuditStorage, AuditErrorHandler } from "./types.ts";

let _storage: AuditStorage | null = null;
let _onError: AuditErrorHandler | undefined;
let _fallbackStorage: AuditStorage | undefined;

export function _setGlobalStorage(
  storage: AuditStorage,
  onError?: AuditErrorHandler,
  fallbackStorage?: AuditStorage,
): void {
  _storage = storage;
  _onError = onError;
  _fallbackStorage = fallbackStorage;
}

export function _defaultFallbackStorage(): AuditStorage | undefined {
  return _fallbackStorage;
}

export function _defaultStorage(): AuditStorage | null {
  return _storage;
}

export function _defaultOnError(): AuditErrorHandler | undefined {
  return _onError;
}
