/**
 * Shared helpers for building / verifying the desktop pgdata-template.
 *
 * Everything runs the BUNDLED PostgreSQL binaries (desktop/src-tauri/resources/postgres/bin)
 * so the template is produced by exactly the server version that will open it on the
 * customer's machine.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const BACKEND_ROOT = join(REPO_ROOT, "backend");
export const RESOURCES = join(REPO_ROOT, "desktop", "src-tauri", "resources");
export const PG_BIN = join(RESOURCES, "postgres", "bin");
// PGDATA_TEMPLATE_DIR lets the gate be exercised against a deliberately dirty copy (tests only).
export const TEMPLATE_DIR = process.env.PGDATA_TEMPLATE_DIR
  ? resolve(process.env.PGDATA_TEMPLATE_DIR)
  : join(RESOURCES, "postgres", "pgdata-template");
export const TEMPLATE_MANIFEST = join(dirname(TEMPLATE_DIR), "pgdata-template.manifest.json");
export const DB_NAME = "erp";
export const DB_SUPERUSER = "postgres";

/** Tables allowed to hold rows in a shipped template, with the exact expected row count. */
export const EXPECTED_ROWS = {
  tenants: 1,
  users: 0,
  licenses: 1,
};

const backendRequire = createRequire(join(BACKEND_ROOT, "package.json"));
export const pg = backendRequire("pg");

export function pgTool(name) {
  const p = join(PG_BIN, `${name}.exe`);
  if (!existsSync(p)) throw new Error(`bundled PostgreSQL tool missing: ${p}`);
  return p;
}

/** Run a bundled tool synchronously; throws with its output on a non-zero exit. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${r.status}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim(),
    );
  }
  return r;
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export function startPostgres(pgdata, port, logFile) {
  // stdio MUST be "ignore": the postmaster inherits pg_ctl's handles, so a piped stdout/stderr
  // would keep spawnSync waiting forever even after the server is up. Diagnostics go to `logFile`.
  const r = spawnSync(pgTool("pg_ctl"), [
    "start",
    "-D",
    pgdata,
    "-l",
    logFile,
    "-w",
    "-t",
    "120",
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`,
  ], { stdio: "ignore", windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const tail = existsSync(logFile)
      ? readFileSync(logFile, "utf8").split(/\r?\n/).slice(-15).join("\n")
      : "(no log)";
    throw new Error(`pg_ctl start failed (exit ${r.status}); server log tail:\n${tail}`);
  }
}

/** Clean shutdown — never `-m immediate` (that would leave a crash-recovery WAL on the template). */
export function stopPostgresClean(pgdata) {
  run(pgTool("pg_ctl"), ["stop", "-D", pgdata, "-m", "smart", "-w", "-t", "120"]);
}

export function databaseUrl(port, db = DB_NAME) {
  return `postgresql://${DB_SUPERUSER}@127.0.0.1:${port}/${db}`;
}

export async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Number of migrations listed in the drizzle journal (what a fully migrated DB must have applied). */
export function journalEntryCount() {
  const j = JSON.parse(
    readFileSync(
      join(BACKEND_ROOT, "src", "infrastructure", "orm", "migrations", "meta", "_journal.json"),
      "utf8",
    ),
  );
  return j.entries.length;
}

/**
 * Assert the database is fully migrated and contains ONLY the clean seed
 * (company + admin + baked license). Returns a summary; throws on any violation.
 */
export async function assertCleanSeed(url, { expectTenantId } = {}) {
  return withClient(url, async (c) => {
    const problems = [];

    const journal = journalEntryCount();
    const mig = await c.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    const applied = mig.rows[0].n;
    if (applied !== journal) {
      problems.push(`migrations applied=${applied} but journal has ${journal}`);
    }

    const tables = (
      await c.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
      )
    ).rows.map((r) => r.table_name);

    const counts = {};
    for (const t of tables) {
      const r = await c.query(`SELECT count(*)::int AS n FROM "${t}"`);
      counts[t] = r.rows[0].n;
    }
    for (const [t, n] of Object.entries(counts)) {
      const want = EXPECTED_ROWS[t] ?? 0;
      if (n !== want) problems.push(`table ${t}: ${n} rows, expected ${want}`);
    }
    for (const t of Object.keys(EXPECTED_ROWS)) {
      if (!(t in counts)) problems.push(`expected table ${t} is missing`);
    }
    if (!("document_sequences" in counts)) problems.push("document_sequences table is missing");

    const lic = await c.query(
      `SELECT key, status, offline_token IS NOT NULL AS has_token, tenant_id FROM licenses LIMIT 1`,
    );
    if (lic.rows[0]) {
      if (lic.rows[0].status !== "active") problems.push("baked license is not active");
      if (!lic.rows[0].has_token) problems.push("baked license has no offline token");
      if (expectTenantId && lic.rows[0].tenant_id !== expectTenantId)
        problems.push("baked license is bound to a different tenant");
    }
    const ten = await c.query(`SELECT id FROM tenants`);
    if (expectTenantId && ten.rows[0]?.id !== expectTenantId)
      problems.push(`tenant id ${ten.rows[0]?.id} != expected ${expectTenantId}`);

    if (problems.length) {
      throw new Error(`pgdata-template is NOT clean:\n - ${problems.join("\n - ")}`);
    }
    return {
      migrationsApplied: applied,
      journalEntries: journal,
      tableCount: tables.length,
      nonEmpty: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
      licenseKey: lic.rows[0]?.key ?? null,
    };
  });
}
