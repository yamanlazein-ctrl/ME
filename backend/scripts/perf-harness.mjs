#!/usr/bin/env node
/**
 * REPAIR-031 / OLD-PLAN Phase 4 — performance harness with real timed queries.
 *
 * Usage: node backend/scripts/perf-harness.mjs [--url DATABASE_URL] [--tenant UUID]
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

async function timeMs(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ scenario: label, ms: Math.round(ms * 100) / 100, ...result }));
  return ms;
}

async function main() {
  const client = await pool.connect();
  try {
    let tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;
    if (!tenantId) {
      const t = await client.query(`SELECT id FROM tenants LIMIT 1`);
      tenantId = t.rows[0]?.id;
    }
    if (!tenantId) {
      console.log("[perf-harness] no tenant — scaffold only");
      process.exit(0);
    }

    await timeMs("S-P1_statement_page_200", async () => {
      const r = await client.query(
        `SELECT id FROM ledger_entries
          WHERE tenant_id = $1
          ORDER BY date ASC, created_at ASC, id ASC
          LIMIT 200`,
        [tenantId],
      );
      return { rows: r.rowCount };
    });

    await timeMs("S-P2_invoice_ilike", async () => {
      const r = await client.query(
        `SELECT id FROM invoices
          WHERE tenant_id = $1 AND number ILIKE $2
          LIMIT 50`,
        [tenantId, "%INV%"],
      );
      return { rows: r.rowCount };
    });

    await timeMs("S-P3_invoice_exact", async () => {
      const r = await client.query(
        `SELECT id FROM invoices WHERE tenant_id = $1 ORDER BY date DESC LIMIT 1`,
        [tenantId],
      );
      const num = r.rows[0] ? (
        await client.query(
          `SELECT id FROM invoices WHERE tenant_id = $1 AND number = $2`,
          [tenantId, (await client.query(`SELECT number FROM invoices WHERE id = $1`, [r.rows[0].id])).rows[0]?.number],
        )
      ) : { rowCount: 0 };
      return { rows: num.rowCount };
    });

    await timeMs("S-P4_profit_year_scan", async () => {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM invoices
          WHERE tenant_id = $1 AND type = 'sale' AND status = 'active'
            AND date >= date_trunc('year', CURRENT_DATE)::date`,
        [tenantId],
      );
      return { invoices: r.rows[0]?.n };
    });

    await timeMs("S-P5_parties_search", async () => {
      const r = await client.query(
        `SELECT id FROM parties WHERE tenant_id = $1 AND name ILIKE $2 LIMIT 30`,
        [tenantId, "%a%"],
      );
      return { rows: r.rowCount };
    });

    console.log("[perf-harness] done — review ms vs proposed gates in docs/decisions.md");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
