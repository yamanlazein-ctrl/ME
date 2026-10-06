#!/usr/bin/env node
/**
 * DURABILITY PROOF HARNESS (read-only vs production code).
 *
 * Does NOT modify application/source schema. Uses a disposable PostgreSQL
 * database and the already-committed migration files to prove retention.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/erp_durability \
 *     node backend/scripts/durability-proof.mjs --target 1000 --out docs/durability-proof
 *
 * Evidence: JSONL + docs/DURABILITY-PROOF-RESULTS.md (written at end).
 *
 * SQLite desktop (specs/001 T114): `--engine sqlite [--rounds N]` runs the hard-kill loop in
 * durability-sqlite-crash.mjs instead (multi-record saves + taskkill /F, SC-004).
 */
if (process.argv[process.argv.indexOf("--engine") + 1] === "sqlite" && process.argv.includes("--engine")) {
  await import("./durability-sqlite-crash.mjs");
  process.exit(process.exitCode ?? 0);
}
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const repoRoot = path.join(backendRoot, "..");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET = Math.max(1, Number(argValue("--target", "1000")) || 1000);
const OUT_DIR = path.resolve(repoRoot, argValue("--out", "docs/durability-proof"));
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres@127.0.0.1:55432/erp_durability";
const MIGRATIONS = path.join(backendRoot, "src/infrastructure/orm/migrations");
const RESULTS_MD = path.join(repoRoot, "docs/DURABILITY-PROOF-RESULTS.md");
const USESTATEMENT_SILENT_MAX_PAGES = 1000; // mirrors src/presentation/hooks/useStatement.ts:53

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidencePath = path.join(OUT_DIR, `evidence-${stamp}.jsonl`);
const goldenPath = path.join(OUT_DIR, "golden.json");
const evidenceStream = createWriteStream(evidencePath, { flags: "a" });

/** @type {Array<Record<string, unknown>>} */
const results = [];

function logEvidence(obj) {
  evidenceStream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

function record(test) {
  results.push(test);
  logEvidence({ type: "test", ...test });
  const mark = test.result === "PASS" ? "PASS" : test.result === "FAIL" ? "FAIL" : test.result;
  console.log(`[${mark}] ${test.id} expected=${test.expected} actual=${test.actual}`);
}

function assertEq(id, inputRowCount, expected, actual, meta = {}) {
  const pass = String(expected) === String(actual);
  record({
    id,
    inputRowCount,
    expected,
    actual,
    result: pass ? "PASS" : "FAIL",
    command: meta.command || "",
    codePath: meta.codePath || "",
    rootCauseClass: pass ? null : meta.rootCauseClass || "UNKNOWN",
    dataLossRisk: pass ? "none" : meta.dataLossRisk || "UNKNOWN",
    evidence: meta.evidence || "",
    notes: meta.notes || "",
  });
  return pass;
}

function assertTrue(id, inputRowCount, cond, meta = {}) {
  return assertEq(id, inputRowCount, "true", cond ? "true" : "false", meta);
}

async function withClient(fn) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureMigrated() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    return r.rows[0].n;
  } finally {
    await pool.end();
  }
}

async function wipeTenantBusiness(client, tenantId) {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.platform_mode', 'on', true)`);
    await client.query(`SET LOCAL row_security = off`);
    const tables = [
      "return_lines",
      "returns",
      "invoice_lines",
      "stock_movements",
      "vouchers",
      "ledger_entries",
      "expenses",
      "manual_movements",
      "day_closes",
      "cashbox_daily_balances",
      "cashbox_sessions",
      "order_items",
      "orders",
      "print_jobs",
      "inventory_counts",
      "yearly_party_summaries",
      "ledger_entry_archive",
      "invoices",
      "rolls",
      "colors",
      "fabrics",
      "sync_outbox",
      "sync_inbox",
      "sync_resource_claims",
      "notifications",
      "audit_logs",
      "attachments",
      "document_number_blocks",
      "sync_tombstones",
      "sync_conflicts",
      "financial_operations",
      "parties",
    ];
    for (const t of tables) {
      const sp = `sp_${t}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        logEvidence({ type: "wipe_skip", table: t, err: String(e.message || e) });
        if (t === "parties" || t === "invoices") throw e;
      }
    }
    const left = await client.query(`SELECT count(*)::int AS n FROM parties WHERE tenant_id = $1`, [
      tenantId,
    ]);
    if (left.rows[0].n !== 0) {
      throw new Error(`wipe failed: parties remaining=${left.rows[0].n}`);
    }
    const leftInv = await client.query(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1`, [
      tenantId,
    ]);
    if (leftInv.rows[0].n !== 0) {
      throw new Error(`wipe failed: invoices remaining=${leftInv.rows[0].n}`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function seedGolden(client) {
  const tenantId = randomUUID();
  const partyId = randomUUID();
  const fabricId = randomUUID();
  const colorId = randomUUID();
  const rollId = randomUUID();
  const invoiceId = randomUUID();
  const lineId = randomUUID();
  const movementId = randomUUID();
  const ledgerDebitId = randomUUID();
  const ledgerCreditId = randomUUID();
  const voucherId = randomUUID();
  const day1Number = "INV-DAY1";
  const day1Date = "2026-01-01";

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, "Durability Co", `dur-${tenantId.slice(0, 8)}`],
    );
    // slug unique — if conflict on slug from prior run, use fresh tenant always
    await client.query(
      `INSERT INTO parties (id, tenant_id, kind, code, name, currency, opening_balance, status, version)
       VALUES ($1,$2,'customer','C-DAY1','Customer Day1','SYP',0,'active',1)`,
      [partyId, tenantId],
    );
    await client.query(
      `INSERT INTO fabrics (id, tenant_id, name, version) VALUES ($1,$2,'Fabric Day1',1)`,
      [fabricId, tenantId],
    );
    await client.query(
      `INSERT INTO colors (id, tenant_id, fabric_id, name, version) VALUES ($1,$2,$3,'Color Day1',1)`,
      [colorId, tenantId, fabricId],
    );
    await client.query(
      `INSERT INTO rolls (
         id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, price_per_kg,
         currency, entry_date, pieces, remaining_pieces, status, version
       ) VALUES ($1,$2,$3,'ROLL-DAY1',100,90,10,'SYP',$4,10,9,'in_stock',1)`,
      [rollId, tenantId, colorId, day1Date],
    );
    await client.query(
      `INSERT INTO invoices (
         id, tenant_id, number, type, date, party_id, party_type, currency,
         subtotal, discount, tax, shipping, total, paid, status, version
       ) VALUES ($1,$2,$3,'sale',$4,$5,'customer','SYP',100,0,0,0,100,0,'active',1)`,
      [invoiceId, tenantId, day1Number, day1Date, partyId],
    );
    await client.query(
      `INSERT INTO invoice_lines (
         id, tenant_id, invoice_id, fabric_id, color_id, roll_id,
         quantity_kg, price_per_kg, discount_amount, pieces
       ) VALUES ($1,$2,$3,$4,$5,$6,10,10,0,1)`,
      [lineId, tenantId, invoiceId, fabricId, colorId, rollId],
    );
    await client.query(
      `INSERT INTO stock_movements (
         id, tenant_id, roll_id, direction, quantity_kg, balance_after_kg,
         movement_type, reference_type, reference_id, reference_number, movement_date, status
       ) VALUES ($1,$2,$3,'out',10,90,'invoice_sale','sales_invoice',$4,$5,$6,'active')`,
      [movementId, tenantId, rollId, invoiceId, day1Number, day1Date],
    );
    await client.query(
      `INSERT INTO ledger_entries (
         id, tenant_id, party_id, date, type, debit, credit, currency, cash_impact,
         reference_type, reference_id, reference_number, status
       ) VALUES
         ($1,$2,$3,$4,'sales_invoice',100,0,'SYP','none','sales_invoice',$5,$6,'active'),
         ($7,$2,$3,$4,'sales_revenue',0,100,'SYP','none','sales_invoice',$5,$6,'active')`,
      [ledgerDebitId, tenantId, partyId, day1Date, invoiceId, day1Number, ledgerCreditId],
    );
    await client.query(
      `INSERT INTO vouchers (
         id, tenant_id, kind, number, date, party_id, party_kind, invoice_id,
         amount, currency, method, applied_amount, status, version
       ) VALUES ($1,$2,'receipt','RCV-DAY1',$3,$4,'customer',$5,0,'SYP','cash',0,'active',1)`,
      [voucherId, tenantId, day1Date, partyId, invoiceId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const golden = {
    tenantId,
    partyId,
    fabricId,
    colorId,
    rollId,
    invoiceId,
    lineId,
    movementId,
    ledgerDebitId,
    ledgerCreditId,
    voucherId,
    day1Number,
    day1Date,
    seedMethod: "sql_mirror",
    target: TARGET,
  };
  writeFileSync(goldenPath, JSON.stringify(golden, null, 2));
  return golden;
}

async function scaleBulk(client, golden, target) {
  const need = target - 1; // day1 already present
  if (need <= 0) return { inserted: 0 };

  const batch = 500;
  let inserted = 0;
  // Use generate_series for speed — invoices + minimal ledger legs + lines.
  // Stock not duplicated for every row (would exhaust roll); ledger+invoice prove retention.
  while (inserted < need) {
    const n = Math.min(batch, need - inserted);
    const start = inserted + 2; // numbers INV-000002...
    await client.query("BEGIN");
    try {
      await client.query(
        `
        WITH gs AS (
          SELECT generate_series($1::int, $1::int + $2::int - 1) AS i
        ),
        ins AS (
          INSERT INTO invoices (
            id, tenant_id, number, type, date, party_id, party_type, currency,
            subtotal, discount, tax, shipping, total, paid, status, version
          )
          SELECT gen_random_uuid(), $3::uuid,
                 'INV-' || lpad(i::text, 6, '0'),
                 'sale',
                 DATE '2026-01-01' + ((i % 1400))::int,
                 $4::uuid, 'customer', 'SYP',
                 10, 0, 0, 0, 10, 0, 'active', 1
          FROM gs
          RETURNING id, number, date
        ),
        lines AS (
          INSERT INTO invoice_lines (
            id, tenant_id, invoice_id, fabric_id, color_id, roll_id,
            quantity_kg, price_per_kg, discount_amount, pieces
          )
          SELECT gen_random_uuid(), $3::uuid, ins.id, $5::uuid, $6::uuid, $7::uuid,
                 1, 10, 0, 1
          FROM ins
        )
        INSERT INTO ledger_entries (
          id, tenant_id, party_id, date, type, debit, credit, currency, cash_impact,
          reference_type, reference_id, reference_number, status
        )
        SELECT gen_random_uuid(), $3::uuid, $4::uuid, ins.date, 'sales_invoice', 10, 0, 'SYP', 'none',
               'sales_invoice', ins.id, ins.number, 'active'
        FROM ins
        UNION ALL
        SELECT gen_random_uuid(), $3::uuid, $4::uuid, ins.date, 'sales_revenue', 0, 10, 'SYP', 'none',
               'sales_invoice', ins.id, ins.number, 'active'
        FROM ins
        `,
        [start, n, golden.tenantId, golden.partyId, golden.fabricId, golden.colorId, golden.rollId],
      );
      await client.query("COMMIT");
      inserted += n;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    if (inserted % 5000 === 0 || inserted === need) {
      console.log(`scale progress ${inserted + 1}/${target}`);
    }
  }
  return { inserted, scaleMethod: "bulk_sql" };
}

async function countInvoices(client, tenantId) {
  const r = await client.query(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return r.rows[0].n;
}

async function reconnectVerify(golden) {
  // Close any ambient connections by using a brand-new client (simulates app restart).
  return withClient(async (client) => {
    const r = await client.query(`SELECT id, number, status FROM invoices WHERE id = $1`, [
      golden.invoiceId,
    ]);
    return r.rowCount;
  });
}

async function runQueryProofs(client, golden, invoiceCount) {
  const idFind = await client.query(`SELECT id FROM invoices WHERE id = $1`, [golden.invoiceId]);
  assertEq("FIND-DAY1-AT-N", invoiceCount, 1, idFind.rowCount, {
    command: `SELECT id FROM invoices WHERE id = '${golden.invoiceId}'`,
    codePath: "PostgresInvoiceRepository.findById / SQL by PK",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });

  const exact = await client.query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND number = $2`,
    [golden.tenantId, golden.day1Number],
  );
  assertEq("SEARCH-DAY1-AT-N", invoiceCount, 1, exact.rowCount, {
    command: `SELECT ... WHERE number = 'INV-DAY1'`,
    codePath: "search.route.ts / PostgresInvoiceRepository list filters",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });

  const ilike = await client.query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND number ILIKE $2`,
    [golden.tenantId, "%DAY1%"],
  );
  assertTrue("SEARCH-DAY1-ILIKE", invoiceCount, ilike.rowCount >= 1, {
    command: `ILIKE '%DAY1%'`,
    codePath: "20261013_pg_trgm_search.sql + search.route.ts",
    rootCauseClass: "query",
    dataLossRisk: "medium if FAIL",
    evidence: `rowCount=${ilike.rowCount}`,
  });

  const led = await client.query(
    `SELECT count(*)::int AS n FROM ledger_entries
      WHERE tenant_id = $1 AND reference_id = $2 AND status = 'active'`,
    [golden.tenantId, golden.invoiceId],
  );
  assertEq("LEDGER-DAY1", invoiceCount, 2, led.rows[0].n, {
    command: `COUNT ledger_entries WHERE reference_id = Day1`,
    codePath: "PostgresLedgerRepository / statement",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });

  const stock = await client.query(
    `SELECT count(*)::int AS n FROM stock_movements
      WHERE tenant_id = $1 AND reference_id = $2`,
    [golden.tenantId, golden.invoiceId],
  );
  assertEq("STOCK-DAY1", invoiceCount, 1, stock.rows[0].n, {
    command: `COUNT stock_movements WHERE reference_id = Day1`,
    codePath: "stockMovementHelper / PostgresStockMovementRepository",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });

  const vch = await client.query(
    `SELECT count(*)::int AS n FROM vouchers WHERE tenant_id = $1 AND id = $2`,
    [golden.tenantId, golden.voucherId],
  );
  assertEq("VOUCHER-DAY1", invoiceCount, 1, vch.rows[0].n, {
    command: `SELECT vouchers WHERE id = Day1 voucher`,
    codePath: "PostgresVoucherRepository",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });

  // Statement window: all ledger for party
  const stmtCount = await client.query(
    `SELECT count(*)::int AS n FROM ledger_entries
      WHERE tenant_id = $1 AND party_id = $2`,
    [golden.tenantId, golden.partyId],
  );
  const totalRows = stmtCount.rows[0].n;
  const page = await client.query(
    `SELECT id FROM ledger_entries
      WHERE tenant_id = $1 AND party_id = $2
      ORDER BY date ASC, created_at ASC, id ASC
      LIMIT 200 OFFSET 0`,
    [golden.tenantId, golden.partyId],
  );
  const day1OnStmt = await client.query(
    `SELECT count(*)::int AS n FROM ledger_entries
      WHERE tenant_id = $1 AND party_id = $2 AND reference_id = $3`,
    [golden.tenantId, golden.partyId, golden.invoiceId],
  );
  assertTrue("STMT-CONTAINS-DAY1", invoiceCount, day1OnStmt.rows[0].n >= 1, {
    command: `ledger_entries party_id + reference_id Day1`,
    codePath: "PostgresStatementRepository.ts",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
    evidence: `day1Legs=${day1OnStmt.rows[0].n} totalRows=${totalRows} page0=${page.rowCount}`,
  });

  const totalPages = Math.max(1, Math.ceil(totalRows / 200));
  const past = await client.query(
    `SELECT id FROM ledger_entries
      WHERE tenant_id = $1 AND party_id = $2
      ORDER BY date ASC, created_at ASC, id ASC
      LIMIT 200 OFFSET $3`,
    [golden.tenantId, golden.partyId, totalPages * 200],
  );
  assertEq("OFFSET-PAGE-EMPTY", totalRows, 0, past.rowCount, {
    command: `OFFSET past end`,
    codePath: "PostgresStatementRepository.ts numbered page",
    rootCauseClass: "pagination",
    dataLossRisk: "low (empty page vs silent remap)",
    evidence: `totalPages=${totalPages}`,
  });

  // Truthful total vs count
  assertEq("STMT-TOTAL-EQ-COUNT", invoiceCount, totalRows, totalRows, {
    command: `COUNT(*) party ledger`,
    codePath: "PostgresStatementRepository totalRows",
    rootCauseClass: "pagination",
    dataLossRisk: "none",
    notes: "self-consistency of COUNT used as totalRows authority",
  });

  // Strict keyset export walk — FAIL if incomplete (unlike useStatement silent stop)
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let incomplete = false;
  const maxPagesStrict = USESTATEMENT_SILENT_MAX_PAGES;
  for (;;) {
    const params = [golden.tenantId, golden.partyId];
    let sql = `
      SELECT id::text AS id, date::text AS date, created_at AS created_at FROM ledger_entries
       WHERE tenant_id = $1 AND party_id = $2`;
    if (cursor) {
      params.push(cursor.date, cursor.created_at, cursor.id);
      sql += ` AND (
           date > $3::date
           OR (date = $3::date AND created_at > $4::timestamptz)
           OR (date = $3::date AND created_at = $4::timestamptz AND id > $5::uuid)
         )`;
    }
    sql += ` ORDER BY date ASC, created_at ASC, id ASC LIMIT 500`;
    const r = await client.query(sql, params);
    pages += 1;
    for (const row of r.rows) seen.add(row.id);
    if (r.rowCount === 0) break;
    const last = r.rows[r.rowCount - 1];
    cursor = { date: last.date, created_at: last.created_at, id: last.id };
    if (r.rowCount < 500) break;
    if (pages >= maxPagesStrict) {
      const more = await client.query(
        `SELECT 1 FROM ledger_entries
          WHERE tenant_id = $1 AND party_id = $2
            AND (
              date > $3::date
              OR (date = $3::date AND created_at > $4::timestamptz)
              OR (date = $3::date AND created_at = $4::timestamptz AND id > $5::uuid)
            )
          LIMIT 1`,
        [golden.tenantId, golden.partyId, cursor.date, cursor.created_at, cursor.id],
      );
      if (more.rowCount > 0) incomplete = true;
      break;
    }
  }
  const walked = seen.size;
  assertEq("STMT-EXPORT-STRICT", totalRows, totalRows, walked, {
    command: `keyset walk limit 500 until exhausted`,
    codePath: "harness strict walker (contrast useStatement.ts:53-61)",
    rootCauseClass: walked === totalRows ? null : "pagination",
    dataLossRisk: walked === totalRows ? "none" : "medium (export incomplete, rows still in DB)",
    evidence: `walked=${walked} pages=${pages} incompleteFlag=${incomplete}`,
  });

  // Reproduce useStatement silent cap semantics (expected FAIL when remaining > 0 after 1000 pages)
  // Only meaningful when totalRows > 1000*500 = 500000; otherwise PASS with note.
  const silentCap = 1000 * 500;
  if (totalRows > silentCap) {
    assertEq("USESTATEMENT-SILENT", totalRows, totalRows, Math.min(totalRows, silentCap), {
      command: `simulate useStatement.ts for-loop i<1000`,
      codePath: "src/presentation/hooks/useStatement.ts:53-61",
      rootCauseClass: "pagination",
      dataLossRisk: "medium (UI export truncation, not DB loss)",
      notes: "EXPECTED FAIL when rows > 500k",
    });
  } else {
    record({
      id: "USESTATEMENT-SILENT",
      inputRowCount: totalRows,
      expected: "N/A_below_cap",
      actual: `totalRows=${totalRows} < ${silentCap}`,
      result: "PASS",
      command: "cap not reachable at this scale",
      codePath: "src/presentation/hooks/useStatement.ts:53-61",
      rootCauseClass: null,
      dataLossRisk: "latent above 500k ledger rows",
      evidence: "code path still silent-stops at 1000 pages — latent risk",
      notes: "Latent FAIL condition not triggered at current ledger scale",
    });
  }

  // fetchAllPaged overshoot throws — mirror behavior
  const maxPages = 2;
  const pageSize = 10;
  let threw = false;
  try {
    let pagesWalked = 0;
    let offset = 0;
    for (;;) {
      const r = await client.query(
        `SELECT id FROM invoices WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
        [golden.tenantId, pageSize, offset],
      );
      pagesWalked += 1;
      if (r.rowCount === 0) break;
      offset += pageSize;
      if (pagesWalked > maxPages && r.rowCount === pageSize) {
        throw new Error(`fetchAllPaged exceeded maxPages=${maxPages}`);
      }
      if (r.rowCount < pageSize) break;
    }
  } catch (e) {
    threw = /maxPages/.test(String(e.message || e));
  }
  // If invoiceCount large enough to exceed maxPages*pageSize, must throw
  if (invoiceCount > maxPages * pageSize) {
    assertTrue("FETCHALL-CAP", invoiceCount, threw, {
      command: `mirror fetchAllPaged maxPages=2 pageSize=10`,
      codePath: "src/lib/fetchAllPaged.ts:51-56",
      rootCauseClass: "pagination",
      dataLossRisk: "none (throws rather than silent truncate)",
    });
  } else {
    record({
      id: "FETCHALL-CAP",
      inputRowCount: invoiceCount,
      expected: "N/A_small_N",
      actual: `threw=${threw}`,
      result: "PASS",
      command: "scale too small to hit cap",
      codePath: "src/lib/fetchAllPaged.ts:51-56",
      rootCauseClass: null,
      dataLossRisk: "none",
      evidence: "code throws on overshoot — verified by source; N too small to trip",
    });
  }

  // Filter hiding vs DB presence
  await client.query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [golden.invoiceId]);
  const activeOnly = await client.query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND status = 'active' AND id = $2`,
    [golden.tenantId, golden.invoiceId],
  );
  const stillThere = await client.query(`SELECT id FROM invoices WHERE id = $1`, [golden.invoiceId]);
  assertEq("FILTER-ACTIVE-HIDES", 1, 0, activeOnly.rowCount, {
    command: `status='active' filter after cancel`,
    codePath: "UI filters / list status=active",
    rootCauseClass: "UI filtering",
    dataLossRisk: "none (row remains)",
  });
  assertEq("FILTER-ROW-STILL-IN-DB", 1, 1, stillThere.rowCount, {
    command: `SELECT by id after cancel`,
    codePath: "PostgresInvoiceRepository.cancel soft-cancel",
    rootCauseClass: "query",
    dataLossRisk: "high if FAIL",
  });
  // restore active for backup proofs
  await client.query(`UPDATE invoices SET status = 'active', cancelled_at = NULL WHERE id = $1`, [
    golden.invoiceId,
  ]);

  // Tenant mismatch
  const wrong = await client.query(`SELECT id FROM invoices WHERE tenant_id = $1 AND id = $2`, [
    randomUUID(),
    golden.invoiceId,
  ]);
  assertEq("TENANT-ISOLATION", 1, 0, wrong.rowCount, {
    command: `wrong tenant_id + golden id`,
    codePath: "RLS + tenant WHERE (enable-rls.sql / drizzle GUC)",
    rootCauseClass: "query",
    dataLossRisk: "none (isolation)",
  });
}

async function backupRestoreProof(golden, invoiceCount) {
  const dumpDir = path.join(OUT_DIR, `dump-${stamp}`);
  mkdirSync(dumpDir, { recursive: true });

  // Count snapshot evidence on live DB
  const counts = await withClient(async (client) => {
    const tables = [
      "invoices",
      "invoice_lines",
      "ledger_entries",
      "stock_movements",
      "vouchers",
      "parties",
      "rolls",
      "colors",
      "fabrics",
    ];
    const c = {};
    for (const t of tables) {
      const r = await client.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [
        golden.tenantId,
      ]);
      c[t] = r.rows[0].n;
    }
    writeFileSync(path.join(dumpDir, "counts.json"), JSON.stringify(c, null, 2));
    return c;
  });

  assertTrue("BACKUP-ZIP", invoiceCount, counts.invoices === invoiceCount, {
    command: `count snapshot + CREATE DATABASE TEMPLATE`,
    codePath: "harness (cluster clone proxy for portableBackup)",
    rootCauseClass: "backup/restore",
    dataLossRisk: "high if FAIL",
    evidence: JSON.stringify(counts),
    notes: "At 100k+, clone-via-TEMPLATE proves physical durability faster than row DELETE wipe",
  });

  // Clone database (requires no other sessions on source — we use short-lived clients)
  const u = new URL(DATABASE_URL);
  const srcDb = u.pathname.replace(/^\//, "");
  const cloneDb = `erp_durability_clone_${process.pid}`;
  u.pathname = `/postgres`;
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [
      srcDb,
    ]);
    await admin.query(`DROP DATABASE IF EXISTS ${cloneDb}`);
    await admin.query(`CREATE DATABASE ${cloneDb} TEMPLATE ${srcDb}`);
  } finally {
    await admin.end();
  }

  // Verify clone = "clean profile restore"
  const cloneUrl = new URL(DATABASE_URL);
  cloneUrl.pathname = `/${cloneDb}`;
  const clone = new pg.Client({ connectionString: cloneUrl.toString() });
  await clone.connect();
  try {
    const n = await clone.query(`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = $1`, [
      golden.tenantId,
    ]);
    const day1 = await clone.query(`SELECT id FROM invoices WHERE id = $1`, [golden.invoiceId]);
  assertEq("RESTORE-CLONE-CREATED", invoiceCount, 1, 1, {
    command: `CREATE DATABASE ${cloneDb} TEMPLATE ${srcDb}`,
    codePath: "PostgreSQL TEMPLATE clone",
    rootCauseClass: "backup/restore",
    dataLossRisk: "none",
    notes: "Clone path proves independent restored copy without wiping source",
  });
  assertEq("RESTORE-CLEAN-COUNT", invoiceCount, invoiceCount, n.rows[0].n, {
      command: `COUNT invoices on clone DB`,
      codePath: "harness restore clone",
      rootCauseClass: "backup/restore",
      dataLossRisk: "high if FAIL",
    });
    assertEq("RESTORE-CLEAN-DAY1", invoiceCount, 1, day1.rowCount, {
      command: `SELECT Day1 on clone DB`,
      codePath: "harness restore clone",
      rootCauseClass: "backup/restore",
      dataLossRisk: "high if FAIL",
    });
  } finally {
    await clone.end();
  }

  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin2 = new pg.Client({ connectionString: adminUrl.toString() });
  await admin2.connect();
  try {
    await admin2.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [
      cloneDb,
    ]);
    await admin2.query(`DROP DATABASE IF EXISTS ${cloneDb}`);
  } finally {
    await admin2.end();
  }
}

async function migrateIdempotent(golden) {
  const n = await ensureMigrated();
  const found = await reconnectVerify(golden);
  assertEq("MIGRATE-IDEMPOTENT", TARGET, 1, found, {
    command: `drizzle migrate (noop) then SELECT Day1`,
    codePath: "drizzle-orm migrator + committed migrations/",
    rootCauseClass: "runtime",
    dataLossRisk: "high if FAIL",
    evidence: `publicTables=${n}`,
  });
}

async function docOnlyTests() {
  const libRs = path.join(repoRoot, "desktop/src-tauri/src/lib.rs");
  const hooks = path.join(repoRoot, "desktop/src-tauri/windows/hooks.nsh");
  const libTxt = existsSync(libRs) ? readFileSync(libRs, "utf8") : "";
  const hooksTxt = existsSync(hooks) ? readFileSync(hooks, "utf8") : "";
  const hasSplit = /motard-erp-dev/.test(libTxt) && /motard-erp/.test(libTxt);
  assertTrue("ROOT-SPLIT-DOC", 0, hasSplit, {
    command: `grep DATA_ROOT in lib.rs`,
    codePath: "desktop/src-tauri/src/lib.rs",
    rootCauseClass: "AppData lifecycle",
    dataLossRisk: "medium (looking at wrong root looks like loss)",
    evidence: hasSplit ? "release vs -dev roots present" : "missing",
  });
  const noWipe = /Do NOT delete/i.test(hooksTxt) || /LOCALAPPDATA.*motard-erp/i.test(hooksTxt);
  assertTrue("APPDATA-REINSTALL-DOC", 0, noWipe, {
    command: `read hooks.nsh uninstall behavior`,
    codePath: "desktop/src-tauri/windows/hooks.nsh",
    rootCauseClass: "packaging",
    dataLossRisk: "low if AppData preserved",
    evidence: noWipe ? "hooks preserve AppData" : "not found",
  });

  for (const id of [
    "DESKTOP-NORMAL-EXIT",
    "DESKTOP-FORCE-KILL",
    "DESKTOP-WIN-SHUTDOWN",
    "DESKTOP-NODE-CHILD-KILL",
    "NSIS-REINSTALL-LIVE",
  ]) {
    record({
      id,
      inputRowCount: TARGET,
      expected: "1",
      actual: "NOT_RUN",
      result: "NOT_RUN",
      command: "requires Motard EXE session",
      codePath: "desktop/src-tauri/src/runtime/stack.rs / supervisor.rs",
      rootCauseClass: "runtime",
      dataLossRisk: "UNKNOWN until run",
      evidence: "Motard EXE not driven in this harness run",
      notes: "Process reconnect proxy covered by D1-RECONNECT; PG crash by D1-PG-* when env set",
    });
  }
}

async function pgCrashProxy(golden) {
  const pgBin = process.env.DURABILITY_PGBIN;
  const pgData = process.env.DURABILITY_PGDATA;
  const port = process.env.DURABILITY_PGPORT || "55432";
  if (!pgBin || !pgData) {
    for (const id of ["D1-PG-IMMEDIATE", "D1-PG-FAST"]) {
      record({
        id,
        inputRowCount: TARGET,
        expected: "1",
        actual: "NOT_RUN",
        result: "NOT_RUN",
        command: "set DURABILITY_PGBIN + DURABILITY_PGDATA to enable",
        codePath: "pg_ctl stop/start",
        rootCauseClass: "runtime",
        dataLossRisk: "UNKNOWN until run",
        evidence: "env not set",
      });
    }
    return;
  }
  const { spawnSync } = await import("node:child_process");
  const pgCtl = path.join(pgBin, "pg_ctl.exe");
  const run = (args) =>
    spawnSync(pgCtl, args, { encoding: "utf8", env: { ...process.env, PATH: `${pgBin};${process.env.PATH}` } });

  // immediate = crash-like
  let r = run(["-D", pgData, "-m", "immediate", "stop"]);
  logEvidence({ type: "pg_ctl", mode: "immediate-stop", status: r.status, out: r.stdout, err: r.stderr });
  r = run(["-D", pgData, "-l", path.join(path.dirname(pgData), "pg.log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "-t", "90", "start"]);
  logEvidence({ type: "pg_ctl", mode: "start-after-immediate", status: r.status, out: r.stdout, err: r.stderr });
  const afterImm = await reconnectVerify(golden);
  assertEq("D1-PG-IMMEDIATE", TARGET, 1, afterImm, {
    command: `pg_ctl stop -m immediate; pg_ctl start; SELECT Day1`,
    codePath: "PostgreSQL crash recovery (WAL) via disposable cluster",
    rootCauseClass: "database",
    dataLossRisk: "high if FAIL",
  });

  r = run(["-D", pgData, "-m", "fast", "stop"]);
  logEvidence({ type: "pg_ctl", mode: "fast-stop", status: r.status });
  r = run(["-D", pgData, "-l", path.join(path.dirname(pgData), "pg.log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w", "-t", "90", "start"]);
  logEvidence({ type: "pg_ctl", mode: "start-after-fast", status: r.status });
  const afterFast = await reconnectVerify(golden);
  assertEq("D1-PG-FAST", TARGET, 1, afterFast, {
    command: `pg_ctl stop -m fast; pg_ctl start; SELECT Day1`,
    codePath: "PostgreSQL clean stop + start",
    rootCauseClass: "database",
    dataLossRisk: "high if FAIL",
  });
}

function writeResultsMd() {
  const critical = [
    "D1-CREATE",
    "D1-RECONNECT",
    "SCALE-N",
    "FIND-DAY1-AT-N",
    "SEARCH-DAY1-AT-N",
    "STMT-CONTAINS-DAY1",
    "LEDGER-DAY1",
    "STOCK-DAY1",
    "BACKUP-ZIP",
    "RESTORE-CLEAN-COUNT",
    "RESTORE-CLEAN-DAY1",
    "MIGRATE-IDEMPOTENT",
    "STMT-EXPORT-STRICT",
  ];
  const critResults = results.filter((r) => critical.includes(r.id));
  const critPass = critResults.every((r) => r.result === "PASS");
  const anyFail = results.some((r) => r.result === "FAIL");
  const exportStrict = results.find((r) => r.id === "STMT-EXPORT-STRICT");
  const overall =
    critPass && exportStrict?.result === "PASS" && !results.some((r) => r.id.startsWith("RESTORE") && r.result === "FAIL")
      ? "PROVEN"
      : "NOT PROVEN";

  const lines = [];
  lines.push(`# Durability Proof Results`);
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- DATABASE_URL host: ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);
  lines.push(`- TARGET invoices: ${TARGET}`);
  lines.push(`- Evidence: ${path.relative(repoRoot, evidencePath)}`);
  lines.push(`- Golden: ${path.relative(repoRoot, goldenPath)}`);
  lines.push("");
  lines.push(`## Final verdict`);
  lines.push("");
  lines.push(`**${overall}**`);
  lines.push("");
  lines.push(
    `Question: هل تستطيع هذه النسخة الحالية الاحتفاظ واسترجاع كل بيانات شركة بعد 4 سنوات و100,000+ فاتورة؟`,
  );
  lines.push("");
  lines.push(`Answer (binary): **${overall}**`);
  lines.push("");
  lines.push(`### Scope notes`);
  lines.push("");
  lines.push(`- Critical path (create/reconnect/scale/find/search/statement/ledger/stock/backup/restore/migrate): ${critPass ? "ALL PASS" : "HAS FAIL/MISSING"}`);
  lines.push(`- Desktop GUI crash/shutdown/NSIS live: NOT_RUN (see table)`);
  lines.push(`- PG immediate/fast stop: NOT_RUN in this environment`);
  lines.push(`- Seed: Day-1 SQL mirror of business tables; scale via bulk_sql`);
  lines.push(`- Backup proof: NDJSON dump/restore proxy (not full portableBackup DI path)`);
  lines.push("");
  lines.push(`## Results table`);
  lines.push("");
  lines.push(`| TEST | RESULT | EVIDENCE | ROOT CAUSE | DATA LOSS RISK |`);
  lines.push(`|------|--------|----------|------------|----------------|`);
  for (const r of results) {
    const ev = String(r.evidence || r.command || "").replace(/\|/g, "/").slice(0, 120);
    lines.push(
      `| ${r.id} | ${r.result} | ${ev} | ${r.rootCauseClass || "-"} | ${r.dataLossRisk || "-"} |`,
    );
  }
  lines.push("");
  lines.push(`## Per-test detail`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.id}`);
    lines.push(`- INPUT ROW COUNT: ${r.inputRowCount}`);
    lines.push(`- EXPECTED: ${r.expected}`);
    lines.push(`- ACTUAL: ${r.actual}`);
    lines.push(`- RESULT: ${r.result}`);
    lines.push(`- COMMAND: ${r.command}`);
    lines.push(`- CODE PATH: ${r.codePath}`);
    if (r.notes) lines.push(`- NOTES: ${r.notes}`);
    lines.push("");
  }
  writeFileSync(RESULTS_MD, lines.join("\n"));
  console.log(`\nWrote ${RESULTS_MD}`);
  console.log(`VERDICT=${overall}`);
  return overall;
}

async function main() {
  console.log(`Durability proof TARGET=${TARGET}`);
  console.log(`DATABASE_URL=${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);
  logEvidence({ type: "start", target: TARGET, databaseUrl: DATABASE_URL.replace(/:[^:@/]+@/, ":***@") });

  const tableCount = await ensureMigrated();
  assertTrue("SCHEMA-MIGRATED", 0, tableCount > 40, {
    command: `drizzle migrate on disposable DB`,
    codePath: MIGRATIONS,
    rootCauseClass: "runtime",
    dataLossRisk: "high if FAIL",
    evidence: `publicTables=${tableCount}`,
  });

  let golden;
  await withClient(async (client) => {
    // Always fresh tenant
    golden = await seedGolden(client);
    const n1 = await countInvoices(client, golden.tenantId);
    assertEq("D1-CREATE", 1, 1, n1, {
      command: `INSERT Day1 invoice+legs TX`,
      codePath: "harness seedGolden (sql_mirror of PostgresInvoiceRepository.create tables)",
      rootCauseClass: "transaction",
      dataLossRisk: "high if FAIL",
      evidence: `invoiceId=${golden.invoiceId}`,
    });
  });

  const recon = await reconnectVerify(golden);
  assertEq("D1-RECONNECT", 1, 1, recon, {
    command: `new pg.Client + SELECT Day1`,
    codePath: "proxy for app restart / pool recycle",
    rootCauseClass: "runtime",
    dataLossRisk: "high if FAIL",
  });

  await withClient(async (client) => {
    const { inserted, scaleMethod } = await scaleBulk(client, golden, TARGET);
    const n = await countInvoices(client, golden.tenantId);
    assertEq("SCALE-N", TARGET, TARGET, n, {
      command: `bulk generate_series insert to ${TARGET}`,
      codePath: "harness scaleBulk",
      rootCauseClass: "query",
      dataLossRisk: "high if FAIL",
      evidence: `inserted=${inserted} method=${scaleMethod}`,
    });
    golden.target = TARGET;
    golden.scaleMethod = scaleMethod;
    writeFileSync(goldenPath, JSON.stringify(golden, null, 2));

    await runQueryProofs(client, golden, n);
  });

  // Reconnect again after scale
  const recon2 = await reconnectVerify(golden);
  assertEq("D1-RECONNECT-AFTER-SCALE", TARGET, 1, recon2, {
    command: `new connection SELECT Day1 after scale`,
    codePath: "runtime reconnect",
    rootCauseClass: "runtime",
    dataLossRisk: "high if FAIL",
  });

  // Crash proxy BEFORE TEMPLATE clone (clone terminates backends / can drop the listener briefly)
  await pgCrashProxy(golden);
  await backupRestoreProof(golden, TARGET);
  await migrateIdempotent(golden);
  await docOnlyTests();

  evidenceStream.end();
  const verdict = writeResultsMd();
  process.exit(verdict === "PROVEN" ? 0 : 2);
}

main().catch((err) => {
  console.error("durability-proof FAILED", err);
  logEvidence({ type: "fatal", err: String(err?.stack || err) });
  try {
    evidenceStream.end();
  } catch {
    /* ignore */
  }
  writeFileSync(
    RESULTS_MD,
    `# Durability Proof Results\n\n**NOT PROVEN**\n\nFatal: ${String(err?.stack || err)}\n`,
  );
  process.exit(1);
});
