import type { AuditStorage, AuditErrorHandler } from "./types.ts";

let _storage: AuditStorage | null = null;
let _onError: AuditErrorHandler | undefined;

export function _setGlobalStorage(storage: AuditStorage, onError?: AuditErrorHandler): void {
  _storage = storage;
  _onError = onError;
}

export function _defaultStorage(): AuditStorage | null {
  return _storage;
}

export function _defaultOnError(): AuditErrorHandler | undefined {
  return _onError;
}
