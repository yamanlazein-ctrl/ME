/**
 * Vitest setup file — applied before each test file is loaded.
 *
 * Currently used to surface unhandled rejection warnings during tests.
 * As more tests land in 0C/0E/0G, integration helpers (test DB,
 * fixtures, request stubs) will be added here.
 */

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[vitest] unhandledRejection:", reason);
});

// DB_ENGINE=sqlite (npm run test:sqlite, T064): one SQLite file per run (vitest.config.ts). The
// first test file creates it (FRESH); every later file reuses it (REUSE), like the shared erp_test
// database the PostgreSQL run uses. The runtime itself boots lazily on first use.
if (process.env.DB_ENGINE === "sqlite" && process.env.SQLITE_PATH) {
  const { existsSync } = await import("node:fs");
  process.env.MOTARD_STARTUP_STATE = existsSync(process.env.SQLITE_PATH) ? "REUSE" : "FRESH";
}
