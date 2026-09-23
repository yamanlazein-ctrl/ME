#!/usr/bin/env node
/**
 * OLD-PLAN Phase 3 — read-only reconciliation checks for one tenant.
 *
 * Usage:
 *   node backend/scripts/reconcile-integrity.mjs [--url DATABASE_URL] [--tenant TENANT_UUID]
 *
 * Exit 0 when all checks pass; non-zero with JSON summary of failures.
 */
import pg from "pg";

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const tenantIdx = args.indexOf("--tenant");
const DATABASE_URL =
  (urlIdx !== -1 ? args[urlIdx + 1] : undefined) ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/erp";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    let tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;
    if (!tenantId) {
      const t = await client.query(`SELECT id FROM tenants ORDER BY created_at NULLS LAST LIMIT 1`);
      tenantId = t.rows[0]?.id ?? null;
    }
    if (!tenantId) {
      console.error(JSON.stringify({ ok: false, error: "no tenant" }));
      process.exit(2);
    }

    const failures = [];

    // 1) Stock: remaining_kg vs last movement balance_after (when movements exist)
    const stock = await client.query(
      `SELECT r.id, r.roll_no, r.remaining_kg::numeric AS remaining,
              m.balance_after_kg::numeric AS last_balance
         FROM rolls r
         LEFT JOIN LATERAL (
           SELECT balance_after_kg FROM stock_movements sm
            WHERE sm.roll_id = r.id AND sm.tenant_id = r.tenant_id
            ORDER BY sm.created_at DESC, sm.id DESC
            LIMIT 1
         ) m ON true
        WHERE r.tenant_id = $1
          AND m.balance_after_kg IS NOT NULL
          AND abs(r.remaining_kg::numeric - m.balance_after_kg::numeric) > 0.01
        LIMIT 50`,
      [tenantId],
    );
    if (stock.rows.length) {
      failures.push({ check: "stock_vs_movements", count: stock.rows.length, sample: stock.rows.slice(0, 5) });
    }

    // 2) Invoice lines without cost_per_kg on active sales
    const cogsNull = await client.query(
      `SELECT count(*)::int AS n
         FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
        WHERE il.tenant_id = $1 AND i.type = 'sale' AND i.status = 'active'
          AND il.cost_per_kg IS NULL`,
      [tenantId],
    );
    if ((cogsNull.rows[0]?.n ?? 0) > 0) {
      failures.push({ check: "null_cost_per_kg", count: cogsNull.rows[0].n });
    }

    // 3) Party ledger balance sanity: no NaN / extreme imbalance flags via orphan refs
    const orphanLedger = await client.query(
      `SELECT count(*)::int AS n FROM ledger_entries le
        WHERE le.tenant_id = $1 AND le.party_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.id = le.party_id)`,
      [tenantId],
    );
    if ((orphanLedger.rows[0]?.n ?? 0) > 0) {
      failures.push({ check: "orphan_ledger_party", count: orphanLedger.rows[0].n });
    }

    // 4) Sync dead backlog
    const dead = await client.query(
      `SELECT count(*)::int AS n FROM sync_outbox
        WHERE tenant_id = $1 AND status = 'dead'`,
      [tenantId],
    );
    if ((dead.rows[0]?.n ?? 0) > 0) {
      failures.push({ check: "sync_dead", count: dead.rows[0].n });
    }

    const ok = failures.length === 0;
    console.log(JSON.stringify({ ok, tenantId, failures }, null, 2));
    process.exit(ok ? 0 : 1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
