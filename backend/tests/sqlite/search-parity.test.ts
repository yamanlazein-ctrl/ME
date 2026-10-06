/**
 * T063 (specs/001-desktop-sqlite-engine, research I-4): search parity. The same corpus is loaded
 * into the live PostgreSQL test database and a fresh SQLite file, and every search port method is
 * called with the same inputs on both. Result sets AND order must be identical.
 *
 * Corpus: Arabic (hamza variants, definite article), Latin (case), mixed, digits, and names/codes
 * containing `%`, `_` and `\`. Queries include those characters (they must match literally) and
 * non-ASCII case pairs (PG ILIKE under locale C folds ASCII only — so does SQLite LIKE).
 *
 * Needs the PostgreSQL reference: runs in `npm test`; skipped visibly in `npm run test:sqlite`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const pgUrl = process.env.DB_ENGINE === "sqlite" ? undefined : (process.env.TEST_DB_URL ?? process.env.DATABASE_URL);
const tenantId = randomUUID();
const root = mkdtempSync(join(tmpdir(), "motard-search-"));

const PARTIES: Array<[string, string, string]> = [
  ["customer", "أحمد التاجر", "C-100"],
  ["customer", "احمد الحلبي", "C-101"],
  ["customer", "إيلاف للأقمشة", "c_100"],
  ["customer", "الأقمشة الحديثة", "C%50"],
  ["customer", "ABC Textiles", "ABC-1"],
  ["customer", "abc trading", "abc-2"],
  ["customer", "Ünïcode Ltd", "U-1"],
  ["customer", "ünïcode small", "u-2"],
  ["customer", "back\\slash co", "B\\1"],
  ["customer", "شركة_النور 50%", "N_1"],
  ["supplier", "معمل النسيج", "S-1"],
  ["supplier", "Mixed معمل Ltd", "S-2"],
  ["supplier", "100% Cotton", "S-100"],
];
const PARTY_IDS = PARTIES.map(() => randomUUID());
const ROLL_NOS = ["R-001", "r_002", "R%3", "R\\4", "ر-5"];
const ROLL_IDS = ROLL_NOS.map(() => randomUUID());
const FABRICS = ["قطن مصري", "قطن_هندي", "Cotton 100%", "COTTON blend", "Polyester\\x"];
const QUERIES = ["أحمد", "احمد", "أ", "الأقمشة", "اقمشة", "ABC", "abc", "Abc", "Ü", "ü", "%", "_", "\\", "50%", "C_1", "c-1", "100", "النور", "معمل", "ltd", "", " ", "Cotton", "قطن"];

type Repo = {
  searchParties(i: unknown): Promise<unknown[]>;
  searchFabrics(t: string, q: string, p: string, l: number): Promise<unknown[]>;
  searchColors(t: string, f: string, p: string, l: number): Promise<unknown[]>;
  searchRolls(t: string, c: string, s: string, p: string, l: number): Promise<unknown[]>;
};
let pgRepo: Repo;
let sqRepo: Repo;
let likeContains: (q: string) => string;
let fabricIds: string[] = [];
let colorId = "";
let pgPool: { query(text: string, v?: unknown[]): Promise<{ rows: unknown[] }> };
let shutdown: () => void = () => {};

async function seedBoth(exec: (text: string, v: unknown[]) => unknown) {
  await exec(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Search parity', $2)`, [tenantId, `sp-${tenantId.slice(0, 8)}`]);
  for (const [i, [kind, name, code]] of PARTIES.entries()) {
    await exec(`INSERT INTO parties (id, tenant_id, kind, name, code, currency) VALUES ($1, $2, $3, $4, $5, 'SYP')`, [PARTY_IDS[i], tenantId, kind, name, code]);
  }
}

beforeAll(async () => {
  if (!pgUrl) return;
  likeContains = (await import("@/infrastructure/utils/likeEscape.js")).likeContains;
  // PostgreSQL reference
  const pgMod = await import("@/infrastructure/orm/drizzle.js");
  pgPool = pgMod.pool as never;
  const { PostgresSearchRepository } = await import("@/infrastructure/repositories/PostgresSearchRepository.js");
  pgRepo = new PostgresSearchRepository(pgMod.db) as never;
  // SQLite (fresh file; this process's PostgreSQL layer is untouched)
  const runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  const boot = runtime.bootSqlite({ path: join(root, "data", "motard.db"), migrationsDir: runtime.resolveSqliteMigrationsFolder(), startupState: "FRESH" });
  const { closeSqlite } = await import("@/infrastructure/orm/sqlite/connection.js");
  shutdown = () => closeSqlite(boot.conns);
  const { sqliteDb } = await import("@/infrastructure/orm/sqlite/transaction.js");
  const { SqliteSearchRepository } = await import("@/infrastructure/repositories/sqlite/SqliteSearchRepository.js");
  sqRepo = new SqliteSearchRepository(sqliteDb() as never) as never;

  // `$n` (repeats allowed) → positional `?`
  const sqExec = (text: string, v: unknown[]) => {
    const args: unknown[] = [];
    const sqlText = text.replace(/\$(\d+)/g, (_m, n: string) => {
      args.push(v[Number(n) - 1]);
      return "?";
    });
    return boot.conns.writer.prepare(sqlText).run(...(args as never[]));
  };
  await seedBoth((t, v) => pgPool.query(t, v));
  await seedBoth(sqExec);
  // fabrics + one colour + rolls, same ids on both
  fabricIds = FABRICS.map(() => randomUUID());
  colorId = randomUUID();
  for (const [i, name] of FABRICS.entries()) {
    const args = [fabricIds[i], tenantId, name];
    await pgPool.query(`INSERT INTO fabrics (id, tenant_id, name) VALUES ($1, $2, $3)`, args);
    sqExec(`INSERT INTO fabrics (id, tenant_id, name) VALUES ($1, $2, $3)`, args);
  }
  for (const [db, run] of [["pg", (t: string, v: unknown[]) => pgPool.query(t, v)], ["sq", sqExec]] as const) {
    void db;
    await run(`INSERT INTO colors (id, tenant_id, fabric_id, name) VALUES ($1, $2, $3, 'Blue_1%')`, [colorId, tenantId, fabricIds[0]]);
    for (const [i, no] of ROLL_NOS.entries()) {
      await run(
        `INSERT INTO rolls (id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, price_per_kg, entry_date, currency) VALUES ($1, $2, $3, $4, $5, $5, $6, '2026-01-01', 'SYP')`,
        [ROLL_IDS[i], tenantId, colorId, no, db === "pg" ? "10.00" : 1000, db === "pg" ? "1000.0000" : 10000000],
      );
    }
  }
});

afterAll(async () => {
  if (!pgUrl) return;
  for (const t of ["rolls", "colors", "fabrics", "parties"]) await pgPool.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
  await pgPool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
  shutdown();
  rmSync(root, { recursive: true, force: true });
});

const ids = (rows: unknown[]) => JSON.stringify((rows as Array<Record<string, unknown>>).map((r) => [r.id, r.name ?? r.rollNo]));

describe.skipIf(!pgUrl)("search parity — PostgreSQL ILIKE ↔ SQLite LIKE (T063)", () => {
  it("parties: identical result sets and order for every query, kind and status", async () => {
    for (const q of QUERIES) {
      for (const kind of ["", "customer", "supplier"]) {
        const input = { tenantId, q: q.trim(), kind, status: "", limit: 50, pattern: q.trim() ? likeContains(q.trim()) : "%", cursor: null };
        const [a, b] = [await pgRepo.searchParties(input), await sqRepo.searchParties(input)];
        expect(ids(b), `q=${JSON.stringify(q)} kind=${kind}`).toBe(ids(a));
      }
    }
  });

  it("fabrics, colours and rolls: identical results for every query", async () => {
    for (const q of QUERIES) {
      const p = q.trim() ? likeContains(q.trim()) : "%";
      expect(ids(await sqRepo.searchFabrics(tenantId, q.trim(), p, 50)), `fabrics q=${JSON.stringify(q)}`).toBe(ids(await pgRepo.searchFabrics(tenantId, q.trim(), p, 50)));
      expect(ids(await sqRepo.searchColors(tenantId, fabricIds[0], p, 50)), `colors q=${JSON.stringify(q)}`).toBe(ids(await pgRepo.searchColors(tenantId, fabricIds[0], p, 50)));
      expect(ids(await sqRepo.searchRolls(tenantId, colorId, "", p, 50)), `rolls q=${JSON.stringify(q)}`).toBe(ids(await pgRepo.searchRolls(tenantId, colorId, "", p, 50)));
    }
  });

  it("the corpus actually exercises the hard cases (non-empty and literal-special matches)", async () => {
    const hit = async (q: string) => (await pgRepo.searchParties({ tenantId, q, kind: "", status: "", limit: 50, pattern: likeContains(q), cursor: null })).length;
    expect(await hit("%")).toBe(3); // C%50, "50%", "100%" — literal, not a wildcard
    expect(await hit("_")).toBe(2); // c_100, شركة_النور / N_1
    expect(await hit("\\")).toBe(1);
    expect(await hit("abc")).toBe(2); // ASCII case folding
    expect(await hit("ü")).toBe(1); // non-ASCII: no folding under locale C
  });
});
