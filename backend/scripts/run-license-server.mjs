/**
 * Boot License Server for local admin-dashboard (:5174 → :8081).
 * Usage: node scripts/run-license-server.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, "..");

const env = {
  ...process.env,
  LICENSE_SERVER_MODE: "server",
  LICENSE_SERVER_PORT: process.env.LICENSE_SERVER_PORT ?? "8081",
  // Prefer loopback for local admin console (DFP-030).
  HOST: process.env.HOST ?? "127.0.0.1",
  LICENSE_ADMIN_OPEN_LOOPBACK: process.env.LICENSE_ADMIN_OPEN_LOOPBACK ?? "1",
};

const child = spawn("npx", ["tsx", "src/scripts/license-server.ts"], {
  cwd: backendRoot,
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 1));
