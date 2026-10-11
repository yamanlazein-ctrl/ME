import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

// Agentic e2e (TesterArmy `e2e`) against an ISOLATED stack: tests/e2e/cert-stack.mjs (re)creates a
// disposable `erp_cert*` PostgreSQL database, seeds one licensed tenant + admin, and serves the
// backend and the UI on their own ports, so a run never touches a real or shared database.
//
// Before a run: a PostgreSQL server must be listening on CERT_PG_PORT (default 56437 — the ports
// 55372–55471 sit in a Windows excluded TCP range) and E2E_ADMIN_PASSWORD must be set.
//
// No `agents` block: these tests use exact `screen`/`expect` steps only, so no AI model, key or
// paid usage is involved. Add a model here before writing `agent.*` steps.
const UI_PORT = process.env.CERT_UI_PORT ?? "18081";
const BACKEND_PORT = process.env.CERT_BACKEND_PORT ?? "18080";

export default {
  tests: "tests/agentic/**/*.e2e.ts",
  targets: [
    {
      engine: web(),
      app: {
        url: `http://localhost:${UI_PORT}`,
        command: {
          executable: "node",
          args: ["tests/e2e/cert-stack.mjs"],
          // The runner passes only PATH/HOME/temp to the child; everything the stack needs goes here.
          env: {
            CERT_UI_PORT: UI_PORT,
            CERT_BACKEND_PORT: BACKEND_PORT,
            CERT_PG_PORT: process.env.CERT_PG_PORT ?? "56437",
            E2E_ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD ?? "",
          },
          startupTimeout: 240_000,
          // Locally, attach to a stack already started with the same env (CI ignores this).
          reuseExisting: true,
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
  // One stack, one tenant: tests create data, so run them one at a time.
  workers: 1,
} satisfies E2EConfig;
