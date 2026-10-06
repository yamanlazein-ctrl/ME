import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
import { sqliteTwinResolver } from "./tests/_sqlite/resolvePlugin";

const here = path.dirname(fileURLToPath(import.meta.url));
// Allow CI/agent live proofs to point DATABASE_URL at a disposable PG without
// .env.test (port 5432) clobbering it. Other keys still come from .env.test.
const preservedDbUrl = process.env.DATABASE_URL;
const preservedTestDbUrl = process.env.TEST_DB_URL;
dotenv.config({ path: path.join(here, ".env.test"), override: true });
dotenv.config({ path: path.join(here, ".env") });
if (preservedDbUrl) process.env.DATABASE_URL = preservedDbUrl;
if (preservedTestDbUrl) process.env.TEST_DB_URL = preservedTestDbUrl;

// DB_ENGINE=sqlite (npm run test:sqlite): no PostgreSQL. The .env files'
// DATABASE_URL is dropped and every run gets its own temp SQLite file
// (fileParallelism is off, so one worker owns it).
if (process.env.DB_ENGINE === "sqlite") {
  delete process.env.DATABASE_URL;
  delete process.env.TEST_DB_URL;
  process.env.SQLITE_PATH ??= path.join(os.tmpdir(), `motard-test-${process.pid}-${Date.now()}.db`);
}

export default defineConfig({
  // test:sqlite — the PG suites import PG modules by name; swap them for their SQLite twins (T064).
  plugins: process.env.DB_ENGINE === "sqlite" ? [sqliteTwinResolver(here)] : [],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      // Live-API E2E (needs server on API_BASE). Run via `npm run test:integration`.
      ...(process.env.API_BASE ? [] : ["tests/audit-findings.test.ts"]),
      // test:sqlite — PostgreSQL-format suites that cannot load without a PostgreSQL server. Each has
      // a SQLite counterpart: backup-restore-roundtrip (portable v2 into a scratch PG database) →
      // tests/sqlite/backup-v3-roundtrip.test.ts.
      ...(process.env.DB_ENGINE === "sqlite" ? ["tests/backup-restore-roundtrip.test.ts"] : []),
    ],
    setupFiles: ["tests/setup.ts"],
    // Integration suites share one test database (erp_test). Sequential files
    // keep hermetic tenant fixtures deterministic across workers.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/presentation/server.ts",
        "src/scripts/**",
        "src/infrastructure/config/logger.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Mirror the tsconfig `@erp/shared/*` path. Vite's object-form aliases
      // are exact keys, not prefixes, so each shared module is mapped
      // explicitly rather than relying on a trailing-slash entry.
      "@erp/shared/statementPaging": fileURLToPath(
        new URL("../packages/shared/src/statementPaging.ts", import.meta.url),
      ),
    },
  },
});
