// Type-level regression test for `drizzleAuditPlugin` (Elysia).
//
// This file is intentionally a `*.test-d.ts` fixture: it is included by
// `tsconfig.json` ("test/**/*.ts"), so `tsc --noEmit` (run by `bun run check`)
// type-checks it — but it does NOT match Vitest's `test/**/*.test.ts` include,
// so it is never executed as a runtime test. Compilation IS the assertion.
//
// Regression guarded: composing the plugin via `.use()` must NOT collapse the
// consuming app's type to `any`. A functional `(app: any) => any` plugin would,
// silently destroying Eden Treaty end-to-end type safety downstream.

import { Elysia } from "elysia";

import { drizzleAuditPlugin } from "../src/middleware/elysia.ts";

const app = new Elysia()
  .use(drizzleAuditPlugin({ getContext: async () => ({ userId: null }) }))
  .get("/ping", () => "pong");

// `0 extends 1 & T` is only true when T is `any`.
type IsAny<T> = 0 extends 1 & T ? true : false;

// If the plugin collapses the app type, this flips to `true` and FAILS to compile.
const _appNotAny: IsAny<typeof app> = false;
void _appNotAny;
