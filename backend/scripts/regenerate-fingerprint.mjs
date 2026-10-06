/**
 * One-shot helper: (re)create the disposable fingerprint database, apply every
 * migration, then write schema-fingerprint.json.
 *
 * Exists because the two existing scripts must be run in order against a
 * freshly migrated DB, and the ordering is easy to get wrong:
 *   1. schema-fingerprint.mjs only READS the live catalog — it never creates
 *      the database and never migrates it. Run against a non-migrated DB it
 *      happily writes an EMPTY fingerprint that looks valid.
 *   2. migrate.mjs applies migrations but needs DATABASE_URL pointed at a
 *      database that already exists.
 */
import pg from "pg";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DB = "erp_fingerprint";
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5432/postgres";
const TARGET_URL = `postgresql://postgres:postgres@localhost:5432/${TARGET_DB}`;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // A terminated connection can leave the old cluster's connections dangling;
  // force-terminate so DROP DATABASE cannot block on them.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid()`,
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
  await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  await admin.end();
  console.log(`[fingerprint] created ${TARGET_DB}`);

  const migrate = spawnSync(process.execPath, [join(BACKEND, "scripts", "migrate.mjs")], {
    env: { ...process.env, DATABASE_URL: TARGET_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(migrate.stdout ?? "");
  if (migrate.status !== 0) {
    process.stderr.write(migrate.stderr ?? "");
    throw new Error("migrate.mjs failed — fingerprint NOT regenerated");
  }

  // schema-fingerprint.mjs opens the target with 'w'. On this Windows host the
  // existing file carries a handle that makes the truncating open fail with
  // UNKNOWN/-4094, while creating a NEW file in the same directory works fine.
  // Deleting first turns an overwrite into a create, which is the only reliable
  // path here. Guarded so a failure leaves the old (stale) file in place.
  const OUT = join(
    BACKEND,
    "src",
    "infrastructure",
    "orm",
    "migrations",
    "meta",
    "schema-fingerprint.json",
  );
  if (existsSync(OUT)) {
    try {
      rmSync(OUT);
    } catch (e) {
      throw new Error(
        `cannot remove the old fingerprint (${e.code ?? e.message}). ` +
          "Close any editor or tool holding schema-fingerprint.json and retry.",
      );
    }
  }

  const gen = spawnSync(process.execPath, [join(BACKEND, "scripts", "schema-fingerprint.mjs")], {
    env: { ...process.env, DATABASE_URL: TARGET_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(gen.stdout ?? "");
  if (gen.status !== 0) {
    process.stderr.write(gen.stderr ?? "");
    throw new Error("schema-fingerprint.mjs failed");
  }
  if (!existsSync(OUT)) throw new Error("fingerprint file was not written");
  const fp = JSON.parse(readFileSync(OUT, "utf8"));
  console.log(
    `[fingerprint] journalIdx=${fp.journalIdx} tables=${Object.keys(fp.tables).length} sha=${fp.sha256.slice(0, 12)}…`,
  );
}

main().catch((e) => {
  console.error("[fingerprint]", e.message);
  process.exit(1);
});
