// Spike S1 (research R2): SQLite on the phone. Six criteria, each reported as `PASS|FAIL <detail>`.
import { open } from "@op-engineering/op-sqlite";
import { registerNumericFunctions } from "@backend/infrastructure/orm/sqlite/numericFunctions";
import { pgNumericDivide } from "@backend/infrastructure/repositories/sqlite/helpers/pgNumericDiv";
import type Database from "better-sqlite3";
import { openRuntime } from "../core/runtime";
import { readSqliteFingerprint, diffSqliteFingerprint } from "../core/schemaFingerprint";
import { COMMITTED_FINGERPRINT, JOURNAL_LAST_IDX } from "../core/generated/migrations";
import { openShimDatabase } from "../platform/sqlite/BetterSqliteShim";
import { hashPin, verifyPin } from "../platform/pinVerifier";
import { getOrCreateDbKey } from "../platform/secureStore";

export interface SpikeLine {
  id: string;
  ok: boolean;
  detail: string;
}

const line = (id: string, ok: boolean, detail = ""): SpikeLine => ({ id, ok, detail });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runS1(): Promise<SpikeLine[]> {
  const out: SpikeLine[] = [];
  const name = `spike-s1-${Date.now()}.db`;
  const key = await getOrCreateDbKey();
  const shim = openShimDatabase({ name, encryptionKey: key });

  // 1. encrypted: the same file cannot be read without the key.
  try {
    shim.exec("CREATE TABLE enc_probe (v TEXT); INSERT INTO enc_probe VALUES ('secret')");
    shim.close();
    let readable = true;
    try {
      const plain = open({ name });
      plain.executeSync("SELECT count(*) FROM sqlite_master");
      plain.close();
    } catch {
      readable = false;
    }
    out.push(
      line("S1-1 encrypted", !readable, readable ? "opened without key" : "refused without key"),
    );
  } catch (e) {
    out.push(line("S1-1 encrypted", false, message(e)));
  }

  const db = openShimDatabase({ name, encryptionKey: key });

  // 2. migrations + fingerprint (functions are checked separately in 4).
  try {
    const runtime = openRuntime(db, { requireFunctions: false });
    const diff = diffSqliteFingerprint(
      COMMITTED_FINGERPRINT,
      readSqliteFingerprint(db, JOURNAL_LAST_IDX),
    );
    out.push(
      line(
        "S1-2 migrations+fingerprint",
        diff.length === 0,
        `${runtime.appliedMigrations.length} applied, ${diff.length} differences${diff[0] ? `: ${diff[0]}` : ""}`,
      ),
    );
  } catch (e) {
    out.push(line("S1-2 migrations+fingerprint", false, message(e)));
  }

  // 3. synchronous calls inside an explicit transaction.
  try {
    db.exec("CREATE TABLE IF NOT EXISTS tx_probe (id INTEGER PRIMARY KEY, v TEXT)");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO tx_probe (v) VALUES (?)").run("a");
    const row = db.prepare("SELECT v FROM tx_probe WHERE id = ?").get(1) as
      { v: string } | undefined;
    const all = db.prepare("SELECT v FROM tx_probe").all();
    db.exec("COMMIT");
    out.push(
      line(
        "S1-3 sync calls in transaction",
        row?.v === "a" && all.length === 1,
        `rows=${all.length}`,
      ),
    );
  } catch (e) {
    if (db.inTransaction) db.exec("ROLLBACK");
    out.push(line("S1-3 sync calls in transaction", false, message(e)));
  }

  // 4. the five motard_* functions.
  try {
    registerNumericFunctions(db as unknown as Database.Database);
    const stmt = db.prepare("SELECT motard_pgdiv(?, ?, ?, ?) AS q");
    const cases: Array<[number, number, number, number]> = [
      [1000, 2, 3, 0],
      [12345678, 4, 14650, 2],
      [-500, 2, 7, 0],
      [1, 6, 3, 0],
    ];
    const bad = cases.filter(([a, sa, b, sb]) => {
      const got = (stmt.get(a, sa, b, sb) as { q: string | null }).q;
      return got !== pgNumericDivide(BigInt(a), sa, BigInt(b), sb);
    });
    out.push(
      line(
        "S1-4 motard functions",
        bad.length === 0,
        `${cases.length - bad.length}/${cases.length} cases`,
      ),
    );
  } catch (e) {
    out.push(line("S1-4 motard functions", false, message(e)));
  }

  // 5. scaled integer 9,007,199,254,740,993 round-trips exactly as bigint.
  try {
    db.exec("CREATE TABLE IF NOT EXISTS big_probe (v INTEGER)");
    db.prepare("INSERT INTO big_probe (v) VALUES (?)").run(9007199254740993n);
    const text = (db.prepare("SELECT CAST(v AS TEXT) AS t FROM big_probe").get() as { t: string })
      .t;
    const raw = (db.prepare("SELECT v FROM big_probe").safeIntegers(true).get() as { v: unknown })
      .v;
    const exact = typeof raw === "bigint" && raw === 9007199254740993n;
    out.push(
      line(
        "S1-5 bigint round-trip",
        exact && text === "9007199254740993",
        `stored=${text} read=${String(raw)} (${typeof raw})`,
      ),
    );
  } catch (e) {
    out.push(line("S1-5 bigint round-trip", false, message(e)));
  }

  // 6. pragmas.
  try {
    const journal = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
    const sync = Number(db.pragma("synchronous", { simple: true }));
    const fk = Number(db.pragma("foreign_keys", { simple: true }));
    out.push(
      line(
        "S1-6 pragmas",
        journal === "wal" && sync !== 0 && fk === 1,
        `journal=${journal} synchronous=${sync} foreign_keys=${fk}`,
      ),
    );
  } catch (e) {
    out.push(line("S1-6 pragmas", false, message(e)));
  }
  db.close();
  return out;
}

/** ARGON2-MS: how long one `verifyPin` takes (research R9: ≤ 1500 ms). */
export async function measureArgon2(): Promise<number> {
  const stored = await hashPin("1234");
  const t0 = Date.now();
  await verifyPin("1234", stored);
  return Date.now() - t0;
}
