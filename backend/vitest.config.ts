import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// Allow CI/agent live proofs to point DATABASE_URL at a disposable PG without
// .env.test (port 5432) clobbering it. Other keys still come from .env.test.
const preservedDbUrl = process.env.DATABASE_URL;
const preservedTestDbUrl = process.env.TEST_DB_URL;
dotenv.config({ path: path.join(here, ".env.test"), override: true });
dotenv.config({ path: path.join(here, ".env") });
if (preservedDbUrl) process.env.DATABASE_URL = preservedDbUrl;
if (preservedTestDbUrl) process.env.TEST_DB_URL = preservedTestDbUrl;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    setupFiles: ["tests/setup.ts"],
    // Integration suites share one test database (erp_test) and audit-findings
    // is a live-API E2E — parallel workers race on tenant rows and crash under
    // load. Sequential files keep runs deterministic.
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
    },
  },
});
