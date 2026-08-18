#!/usr/bin/env node
// Read-only ledger integrity check (Option A — no writes).
//
// Verifies the party-scoped single-sided ledger model invariants:
//   1. No active entry may carry BOTH debit and credit (ambiguous rows).
//   2. Per party + currency, the DB sum of (debit - credit) must match the
//      statement endpoint's previousBalance/finalBalance for the SAME window
//      (customer: balance = debit - credit; supplier: balance = credit - debit).
//   3. Reports any active reference with BOTH nonzero debit and credit sums
//      that are unequal (informational — partial payments are expected to be
//      unbalanced by design until fully settled).
//
// Usage:  node scripts/ledger-integrity-check.mjs [limit]
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// `pg` is a backend dependency — resolve it from backend/node_modules.
const { Client } = require(path.join(root, "backend", "node_modules", "pg"));
const envFile = fs.readFileSync(path.join(root, "backend", ".env"), "utf8");
const m = envFile.match(/^DATABASE_URL=(.+)$/m);
if (!m) {
  console.error("DATABASE_URL not found in backend/.env");
  process.exit(1);
}

const TENANT = process.env.TENANT_ID || "f7a54ec6-0802-48da-a03c-9474b526e081";
const LIMIT = Number(process.argv[2] || 50);

async function main() {
  const c = new Client({ connectionString: m[1].trim() });
  await c.connect();

  console.log(`\n=== LEDGER INTEGRITY CHECK (tenant ${TENANT}) ===`);

  // 1. Ambiguous rows
  const amb = await c.query(
    `select count(*)::int as n from ledger_entries
     where tenant_id=$1 and status='active' and debit>0 and credit>0`,
    [TENANT],
  );
  console.log(`[1] entries with BOTH debit+credit (ambiguous): ${amb.rows[0].n} ${amb.rows[0].n === 0 ? "OK" : "!!"}`);

  // 2. Per-party reconciliation vs statement endpoint
  const api = process.env.API || "http://localhost:8083/api";
  const login = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.ERP_EMAIL || "admin@erp.local", password: process.env.ERP_PASS || "admin123" }),
  });
  const token = (await login.json()).accessToken;
  const h = { Authorization: `Bearer ${token}` };

  const parties = await c.query(
    `select id, kind, code, name from parties
     where tenant_id=$1 and status='active'
     order by (select count(*) from ledger_entries le where le.party_id=parties.id and le.status='active') desc
     limit $2`,
    [TENANT, LIMIT],
  );
  let mismatches = 0;
  let checked = 0;
  for (const p of parties.rows) {
    const cur = await c.query(
      `select round(sum(debit)) as d, round(sum(credit)) as cr
       from ledger_entries where tenant_id=$1 and party_id=$2 and status='active' and currency='SYP'`,
      [TENANT, p.id],
    );
    const { d, cr } = cur.rows[0];
    const dbBalance = p.kind === "customer" ? (d || 0) - (cr || 0) : (cr || 0) - (d || 0);
    const st = await fetch(`${api}/${p.kind === "customer" ? "customers" : "suppliers"}/${p.id}/statement?currency=SYP`, { headers: h });
    const body = await st.json();
    checked++;
    const apiBalance = body.finalBalance;
    const ok = Math.abs((dbBalance || 0) - (apiBalance || 0)) < 1;
    if (!ok) {
      mismatches++;
      console.log(`[2] MISMATCH ${p.kind} ${p.code} ${p.name}: db=${dbBalance} statement=${apiBalance}`);
    }
  }
  console.log(`[2] party reconciliations: checked=${checked} mismatches=${mismatches} ${mismatches === 0 ? "OK" : "!!"}`);

  // 3. References with both sides unequal (informational)
  const refs = await c.query(
    `select reference_type, reference_number, round(sum(debit)) as d, round(sum(credit)) as cr, count(*)::int as rows
     from ledger_entries where tenant_id=$1 and status='active'
     group by reference_type, reference_number
     having sum(debit)>0 and sum(credit)>0 and round(sum(debit))<>round(sum(credit))
     order by abs(round(sum(debit))-round(sum(credit))) desc
     limit 20`,
    [TENANT],
  );
  console.log(`[3] references with BOTH sides (informational, partial-payment) — top ${refs.rows.length}:`);
  refs.rows.forEach((r) => console.log(`    ${r.reference_type} ${r.reference_number}: debit=${r.d} credit=${r.cr} rows=${r.rows}`));

  await c.end();
  console.log("\nDONE");
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
