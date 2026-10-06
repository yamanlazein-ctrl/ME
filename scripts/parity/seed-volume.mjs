#!/usr/bin/env node
/**
 * Volume seeder + completeness baseline (specs/001-desktop-sqlite-engine, task T025 / AC-9).
 *
 *   DATABASE_URL=postgresql://postgres@localhost:55432/erp_volume \
 *     node scripts/parity/seed-volume.mjs [--invoices 100000] [--parties 10000] [--out scripts/parity/baseline/completeness.json]
 *
 * Creates the database if missing, applies every committed migration (journal order — the
 * live schema), then seeds one tenant with:
 *   - N parties (80% customers, 20% suppliers), one of them a "deep" customer with 20% of all invoices
 *     so a single statement spans many pages;
 *   - N invoices (sale, SYP) dated over four years, one 'sales_invoice' debit ledger row each;
 *   - one 'receipt_in' credit ledger row per invoice (cash in → exercises the cash-box daily triggers).
 * Total ledger rows = 2 × invoices (200,000 at the gate).
 *
 * It then writes the completeness baseline: row counts computed with the same predicates the
 * screens use (operational party lists exclude cancelled — D-4; statements = active ledger rows of
 * the party) and a sha256 over every statement's ordered ledger ids, so the SQLite build must
 * reach exactly the same rows. Disposable databases only — never point it at real data.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
// Dependencies live in backend/node_modules (this script sits outside the backend package).
const backendRequire = createRequire(path.join(repoRoot, "backend", "package.json"));
const pg = backendRequire("pg");
const { drizzle } = backendRequire("drizzle-orm/node-postgres");
const { migrate } = backendRequire("drizzle-orm/node-postgres/migrator");
const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const INVOICES = Number(arg("--invoices", "100000"));
const PARTIES = Number(arg("--parties", "10000"));
const OUT = path.resolve(repoRoot, arg("--out", "scripts/parity/baseline/completeness.json"));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (disposable database)");
const target = new URL(url);
const dbName = target.pathname.slice(1);
if (!/^erp_(volume|durability|parity)/.test(dbName)) {
  throw new Error(`refusing to seed "${dbName}": only disposable erp_volume*/erp_parity*/erp_durability* databases`);
}

const admin = new URL(url);
admin.pathname = "/postgres";
const a = new pg.Client({ connectionString: admin.toString() });
await a.connect();
if ((await a.query("SELECT 1 FROM pg_database WHERE datname=$1", [dbName])).rowCount === 0) {
  await a.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  console.log(`[seed-volume] created ${dbName}`);
}
await a.end();

const pool = new pg.Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: path.join(repoRoot, "backend", "src", "infrastructure", "orm", "migrations") });
const c = await pool.connect();
const t0 = Date.now();
const tenantId = randomUUID();
const customers = Math.round(PARTIES * 0.8);
const deepShare = Math.round(INVOICES * 0.2);

await c.query("BEGIN");
await c.query("SELECT set_config('app.platform_mode','on',true)");
await c.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantId]);
await c.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'Volume Co',$2)", [tenantId, `vol-${tenantId.slice(0, 8)}`]);
// parties: p1..pN; p1 is the deep customer
await c.query(
  `INSERT INTO parties (id,tenant_id,kind,code,name,currency,opening_balance,status,version)
   SELECT md5($1::text || ':p:' || g)::uuid, $1::uuid, CASE WHEN g <= $2::int THEN 'customer' ELSE 'supplier' END,
          'P-' || lpad(g::text, 6, '0'), 'Party ' || g, 'SYP', 0, 'active', 1
   FROM generate_series(1, $3) g`,
  [tenantId, customers, PARTIES],
);
// invoices: the first `deepShare` go to the deep customer, the rest round-robin over customers
await c.query(
  `INSERT INTO invoices (id,tenant_id,number,type,date,party_id,party_type,currency,subtotal,discount,tax,shipping,total,paid,status,version)
   SELECT md5($1::text || ':i:' || g)::uuid, $1::uuid, 'INV-' || lpad(g::text, 7, '0'), 'sale',
          DATE '2022-01-01' + ((g::bigint * 1461) / $2::int)::int,
          md5($1::text || ':p:' || CASE WHEN g <= $3::int THEN 1 ELSE 1 + (g % $4::int) END)::uuid, 'customer', 'SYP',
          1000 + (g % 997), 0, 0, 0, 1000 + (g % 997), 0, 'active', 1
   FROM generate_series(1, $2) g`,
  [tenantId, INVOICES, deepShare, customers],
);
// ledger: debit per invoice, credit receipt (cash in) per invoice
await c.query(
  `INSERT INTO ledger_entries (id,tenant_id,party_id,date,type,debit,credit,currency,cash_impact,reference_type,reference_id,reference_number,status)
   SELECT md5(i.id::text || ':d')::uuid, i.tenant_id, i.party_id, i.date, 'sales_invoice', i.total, 0, 'SYP', 'none',
          'sales_invoice', i.id, i.number, 'active'
   FROM invoices i WHERE i.tenant_id = $1`,
  [tenantId],
);
await c.query(
  `INSERT INTO ledger_entries (id,tenant_id,party_id,date,type,debit,credit,currency,cash_impact,reference_type,reference_id,reference_number,status)
   SELECT md5(i.id::text || ':c')::uuid, i.tenant_id, i.party_id, i.date, 'receipt_in', 0, i.total, 'SYP', 'in',
          'receipt_in', i.id, i.number, 'active'
   FROM invoices i WHERE i.tenant_id = $1`,
  [tenantId],
);
await c.query("COMMIT");
console.log(`[seed-volume] seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── completeness baseline (same predicates as the screens) ─────────────────
await c.query("BEGIN");
await c.query("SELECT set_config('app.platform_mode','on',true)");
await c.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantId]);
const one = async (q, p = [tenantId]) => (await c.query(q, p)).rows[0];
const counts = {
  customersList: Number((await one("SELECT count(*) n FROM parties WHERE tenant_id=$1 AND kind='customer' AND status<>'cancelled'")).n),
  suppliersList: Number((await one("SELECT count(*) n FROM parties WHERE tenant_id=$1 AND kind='supplier' AND status<>'cancelled'")).n),
  invoices: Number((await one("SELECT count(*) n FROM invoices WHERE tenant_id=$1")).n),
  ledgerRows: Number((await one("SELECT count(*) n FROM ledger_entries WHERE tenant_id=$1")).n),
  cashboxDailyRows: Number((await one("SELECT count(*) n FROM cashbox_daily_balances WHERE tenant_id=$1")).n),
};
// statements: ordered ledger ids per party (statement order: date, created_at, id) → one digest
const h = createHash("sha256");
let statementLines = 0;
let deepest = { party: null, lines: 0 };
const cur = await c.query(
  `SELECT party_id::text p, string_agg(id::text, ',' ORDER BY date, created_at, id) ids, count(*) n
   FROM ledger_entries WHERE tenant_id=$1 AND status='active' GROUP BY party_id ORDER BY party_id`,
  [tenantId],
);
for (const r of cur.rows) {
  h.update(`${r.p}:${r.ids}\n`);
  statementLines += Number(r.n);
  if (Number(r.n) > deepest.lines) deepest = { party: r.p, lines: Number(r.n) };
}
const closing = await one(
  "SELECT closing_balance::text v FROM cashbox_daily_balances WHERE tenant_id=$1 AND currency='SYP' ORDER BY balance_date DESC LIMIT 1",
);
await c.query("COMMIT");

const baseline = {
  generatedAt: new Date().toISOString(),
  engine: "postgres",
  params: { invoices: INVOICES, parties: PARTIES, deepShare },
  counts,
  statements: { parties: cur.rows.length, totalLines: statementLines, deepest, sha256: h.digest("hex") },
  cashboxClosingSYP: closing?.v ?? null,
  tenantId,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");
console.log(`[seed-volume] baseline → ${OUT}`);
console.log(JSON.stringify(baseline.counts), JSON.stringify(baseline.statements.deepest));
c.release();
await pool.end();
