/**
 * Write the committed SQLite schema fingerprint (specs/001-desktop-sqlite-engine T038).
 *
 *   npx tsx scripts/sqlite-schema-fingerprint.mts [--db <file.db>] [--out <file.json>] [--check]
 *
 * Without --db the schema is built in memory by applying the SQLite journal's migrations, so the
 * fingerprint describes exactly what a fresh desktop database gets. Reading logic is shared with
 * the boot-time verification (src/infrastructure/orm/sqlite/schemaFingerprint.ts).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readSqliteFingerprint, loadSqliteJournal } from "../src/infrastructure/orm/sqlite/schemaFingerprint.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = join(here, "../src/infrastructure/orm/sqlite/migrations");
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const out = arg("--out") ?? join(MIG, "meta/schema-fingerprint.json");
const journal = loadSqliteJournal(MIG);
const dbPath = arg("--db");
const db = new Database(dbPath ?? ":memory:", { readonly: Boolean(dbPath) });
db.pragma("trusted_schema = OFF"); // as in production: the schema must not need app functions
if (!dbPath) for (const e of journal.entries) db.exec(readFileSync(join(MIG, `${e.tag}.sql`), "utf8"));
const fp = readSqliteFingerprint(db, journal.entries.at(-1)!.idx);
db.close();

const text = JSON.stringify(fp, null, 2) + "\n";
const n = (type: string) => Object.values(fp.constraints).filter((c) => c.type === type).length;
const summary = `${Object.keys(fp.tables).length} tables, ${n("p")} PK, ${n("u")} UNIQUE, ${n("c")} CHECK, ${n("f")} FK, ${Object.keys(fp.indexes).length} indexes, ${Object.keys(fp.triggers).length} triggers`;
if (process.argv.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) {
    console.error(`[sqlite-fingerprint] drift: ${out} differs from the migrations (${summary})`);
    process.exit(1);
  }
  console.log(`[sqlite-fingerprint] checked: ${summary}`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`[sqlite-fingerprint] ${summary} → ${out}`);
}
