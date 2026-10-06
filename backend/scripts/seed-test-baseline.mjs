/**
 * Minimal, idempotent baseline fixture for the live (non-mocked) backend suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ensure-test-db.mjs` provisions an EMPTY schema. Two live suites are written
 * as probes against existing business data and refused to run vacuously on an
 * empty database:
 *
 *   - tests/phase8-entitlement-enforcement.test.ts
 *       "no tenant on erp_test — cannot run Phase 8 integration"
 *   - tests/fx-cogs-replay-pin.test.ts
 *       "no sale invoice with cost_per_kg on live postgres — cannot pin FX/COGS"
 *
 * Both are right to refuse rather than assert nothing, but that left the
 * regression gate permanently red on a fresh checkout. This seeds the smallest
 * fixture both need — one tenant, and one active sale invoice whose line
 * carries a pinned cost_per_kg — so they can actually run.
 *
 * It is deliberately narrow:
 *   * idempotent (a second run is a no-op — fixed UUIDs),
 *   * additive only (never deletes or rewrites existing rows),
 *   * balanced: the sale invoice is created fully PAID with a matching ledger
 *     leg, so the seeded rows leave no half-open receivable and skew no
 *     aggregate or cashbox balance that an accounting test reads.
 *
 * Usage: node scripts/seed-test-baseline.mjs   (also run by npm run db:test:setup)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");

// An explicitly set DATABASE_URL survives the .env.test override (same rule as vitest.config.ts).
const preservedDbUrl = process.env.DATABASE_URL;
dotenv.config({ path: path.join(backendRoot, ".env.test"), override: true });
dotenv.config({ path: path.join(backendRoot, ".env") });
if (preservedDbUrl) process.env.DATABASE_URL = preservedDbUrl;

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/erp_test";

// Fixed ids: re-running converges instead of piling up fixtures.
const TENANT_ID = "00000000-0000-4000-8000-00000000b001";
const CUSTOMER_ID = "00000000-0000-4000-8000-00000000c001";
const FABRIC_ID = "00000000-0000-4000-8000-00000000f001";
const COLOR_ID = "00000000-0000-4000-8000-000000000101";
const ROLL_ID = "00000000-0000-4000-8000-000000000201";
const INVOICE_ID = "00000000-0000-4000-8000-00000000a001";
const LINE_ID = "00000000-0000-4000-8000-00000000e001";
const LEDGER_ID = "00000000-0000-4000-8000-00000000d001";

async function seed() {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO tenants (id, name, slug, created_at)
       VALUES ($1, 'Baseline Test Tenant', 'baseline-test-tenant', now())
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID],
    );

    await client.query(
      `INSERT INTO parties (id, tenant_id, name, kind, currency, status, version, created_at, updated_at)
       VALUES ($1, $2, 'Baseline Customer', 'customer', 'SYP', 'active', 1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_ID, TENANT_ID],
    );

    await client.query(
      `INSERT INTO fabrics (id, tenant_id, name, version, created_at, updated_at)
       VALUES ($1, $2, 'Baseline Fabric', 1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [FABRIC_ID, TENANT_ID],
    );

    await client.query(
      `INSERT INTO colors (id, tenant_id, fabric_id, name, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'Baseline Color', 1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [COLOR_ID, TENANT_ID, FABRIC_ID],
    );

    await client.query(
      `INSERT INTO rolls (
         id, tenant_id, color_id, roll_no, initial_kg, remaining_kg,
         pieces, remaining_pieces, price_per_kg, currency, entry_date,
         status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'BASELINE-1', 100, 100, 1, 1, 500, 'SYP', '2026-01-01',
                 'in_stock', 1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [ROLL_ID, TENANT_ID, COLOR_ID],
    );

    // An ACTIVE SALE invoice whose line carries a pinned cost_per_kg — the exact
    // row fx-cogs-replay-pin.test.ts looks for. Fully PAID, so the document is
    // closed and the seeded rows balance.
    await client.query(
      `INSERT INTO invoices (
         id, tenant_id, number, type, party_id, party_type, status, currency,
         date, subtotal, discount, tax, shipping, total, paid, credit_applied,
         version, created_at, updated_at
       ) VALUES ($1, $2, 'BASELINE-SALE-1', 'sale', $3, 'customer', 'active', 'SYP',
                 '2026-01-01', 50000, 0, 0, 0, 50000, 50000, 0,
                 1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [INVOICE_ID, TENANT_ID, CUSTOMER_ID],
    );

    await client.query(
      `INSERT INTO invoice_lines (
         id, tenant_id, invoice_id, roll_id, color_id, fabric_id,
         quantity_kg, price_per_kg, discount_amount, pieces, cost_per_kg
       ) VALUES ($1, $2, $3, $4, $5, $6, 100, 500, 0, 1, 500)
       ON CONFLICT (id) DO NOTHING`,
      [LINE_ID, TENANT_ID, INVOICE_ID, ROLL_ID, COLOR_ID, FABRIC_ID],
    );

    await client.query(
      `INSERT INTO ledger_entries (
         id, tenant_id, party_id, date, type, debit, credit,
         currency, reference_type, reference_id, status, cash_impact, created_at
       ) VALUES ($1, $2, $3, '2026-01-01', 'sales_invoice', 0, 50000,
                 'SYP', 'invoice', $4, 'active', 'in', now())
       ON CONFLICT (id) DO NOTHING`,
      [LEDGER_ID, TENANT_ID, CUSTOMER_ID, INVOICE_ID],
    );

    console.log("baseline fixture ready (tenant + one pinned-cost sale invoice)");
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  await seed();
} catch (e) {
  console.error("baseline seed FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
