/**
 * Boosthis telemetry for DEV runs only — never imported by the server, so it can never reach the
 * esbuild bundle or the desktop installer. Loaded as a preload: `npm run dev:boosthis`, or
 * `NODE_OPTIONS="--import tsx --import file:///<abs path>/backend/scripts/boosthis-dev.mts"` for any harness that
 * spawns src/presentation/server.ts (cwd: backend).
 *
 * Setup (once): fetch the node kit from the Boosthis MCP (`get_integration_kit runtime=node`), unpack it
 * into backend/ (lib/boosthis-* are gitignored), link `node_modules/boosthis-checklist` to
 * lib/boosthis-checklist, and put BOOSTHIS_PROJECT_KEY + a UUID v4 BOOSTHIS_INSTALL_ID in the gitignored
 * backend/.env.boosthis. Without the key this file does nothing.
 *
 * Cost (Boosthis's own figures for this kit): ~83% throughput and ~90 MB RSS — fine for finding the
 * slow routes, wrong for absolute latency numbers, and the reason it is not in the shipped app.
 */
import { isMainThread } from "node:worker_threads";

// Preloads also run in every child process a harness starts and in every worker thread (pino's log
// transport is one — starting the kit there crashed the process natively). Only the API server's main
// thread is measured.
const isServer = isMainThread && /presentation[\\/]server\.ts$/.test(process.argv[1] ?? "");
if (process.env.BOOSTHIS_PROJECT_KEY && isServer) {
  try {
    const { attach, enableTelemetry } = await import("../lib/boosthis-runtime-node/src/index.ts");
    attach(); // must run before Express creates the server
    enableTelemetry({
      installId: process.env.BOOSTHIS_INSTALL_ID,
      inviteKey: process.env.BOOSTHIS_PROJECT_KEY,
      endpoint: "https://www.boosthis.com/api",
      appName: "Motard ERP backend (dev)",
    });
  } catch (e) {
    console.warn(`[boosthis-dev] kit not loaded, running without telemetry: ${(e as Error).message}`);
  }
}
