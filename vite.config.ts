import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["tmp/**", "node_modules/**", "dist/**", "examples/**"],
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov"],
    },
  },
  lint: {
    ignorePatterns: ["tmp/**", "dist/**"],
  },
  fmt: {},
  staged: {
    "*.ts": ["vp fmt", "vp lint"],
  },
  pack: {
    entry: [
      "src/index.ts",
      "src/pg.ts",
      "src/sqlite.ts",
      "src/mysql.ts",
      "src/storage/drizzle.ts",
      "src/storage/console.ts",
      "src/storage/callback.ts",
      "src/storage/multi.ts",
      "src/storage/http.ts",
      "src/transforms/index.ts",
      "src/middleware/hono.ts",
      "src/middleware/elysia.ts",
      "src/middleware/fetch.ts",
      "src/middleware/node.ts",
      "src/middleware/trpc.ts",
      "src/middleware/orpc.ts",
      "src/middleware/graphql.ts",
      "src/middleware/worker.ts",
    ],
    dts: true,
    format: ["esm", "cjs"],
    sourcemap: true,
  },
});
