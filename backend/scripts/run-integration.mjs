/**
 * Integration / E2E test runner.
 *
 * One command that prepares everything the integration suites need:
 *   1. Applies all SQL migrations to the erp_test database (idempotent start
 *      from the first file that has not been applied yet is NOT tracked — we
 *      rely on IF NOT EXISTS/DO-block guards inside newer files; on a fresh
 *      database every file applies cleanly).
 *   2. Seeds admin@erp.local / admin123 into the oldest tenant (the identity
 *      audit-findings.test.ts logs in with).
 *   3. Boots the API server on PORT (default 8081) bound to erp_test.
 *   4. Runs vitest with API_BASE pointing at it, then shuts the server down.
 *
 * Usage:  npm run test:integration [-- vitest args…]
 */
import { spawn, execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const TEST_DB = process.env.TEST_DB_URL ?? "postgresql://postgres:postgres@localhost:5432/erp_test";
const PORT = process.env.PORT ?? "8081";
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT,
  DATABASE_URL: TEST_DB,
  JWT_SECRET: "test-secret-32-chars-minimum-padding-padding",
  JWT_EXPIRY_MS: "1800000",
  REFRESH_TOKEN_EXPIRY_MS: "2592000000",
  CORS_ORIGIN: "http://localhost:5173",
  RATE_LIMIT_RPS: "1000",
  RATE_LIMIT_WINDOW_MS: "60000",
  LOG_LEVEL: "error",
  LICENSE_SERVER_MODE: "embedded",
  APP_MASTER_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
};

async function prepareDatabase() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();

  const dir = join(process.cwd(), "src/infrastructure/orm/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    // Some migrations hardcode the production DB name — adapt for the test DB.
    const sql = raw.replaceAll("DATABASE fabric_erp", "DATABASE erp_test");
    const stmts = sql.split("--> statement-breakpoint");
    try {
      await c.query("BEGIN");
      for (const s of stmts) {
        const t = s.trim();
        if (!t) continue;
        await c.query(t);
      }
      await c.query("COMMIT");
      console.log("migration OK:", f);
    } catch (e) {
      await c.query("ROLLBACK");
      // Already-applied non-idempotent files are fine to skip mid-way.
      console.log(`migration SKIP (${e.message.split("\n")[0].slice(0, 60)}):`, f);
    }
  }

  // Seed the login identity used by audit-findings.test.ts.
  const { hash } = await import("@node-rs/argon2");
  const t = await c.query("select id from tenants order by created_at limit 1");
  if (t.rows.length > 0) {
    await c.query(
      `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
       VALUES ($1, 'Admin', 'admin@erp.local', $2, 'admin', true)
       ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
      [t.rows[0].id, await hash("admin123")],
    );
    console.log("admin@erp.local seeded.");
  }
  await c.end();
}

function waitForHealth(proc) {
  return new Promise((resolve) => {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      if (proc.exitCode !== null || tries > 30) {
        clearInterval(timer);
        return resolve(false);
      }
      try {
        const res = await fetch(`${BASE}/api/health/live`);
        if (res.ok) {
          clearInterval(timer);
          resolve(true);
        }
      } catch {}
    }, 2000);
  });
}

await prepareDatabase();

const server = spawn("npx tsx src/presentation/server.ts", {
  env,
  stdio: ["ignore", "inherit", "inherit"],
  shell: true,
});

const healthy = await waitForHealth(server);
if (!healthy) {
  console.error("Server failed to become healthy — aborting.");
  server.kill("SIGKILL");
  process.exit(1);
}

const vitestArgs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["run"];
let code = 0;
try {
  execSync(`npx vitest ${vitestArgs.join(" ")}`, {
    env: { ...env, API_BASE: BASE },
    stdio: "inherit",
    shell: true,
  });
} catch (e) {
  code = e.status ?? 1;
} finally {
  // shell:true wraps the server in cmd.exe → killing the shell orphans the
  // child node process on Windows. Kill the whole tree instead.
  try {
    execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}
process.exit(code);
