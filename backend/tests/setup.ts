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
