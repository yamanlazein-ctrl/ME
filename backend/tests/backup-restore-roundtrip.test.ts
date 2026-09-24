/**
 * Backup → restore ROUND TRIP (portable format v2) into a separate, freshly
 * migrated database, restored under a DIFFERENT company id (tenant remap).
 *
 * Proves, for one tenant with sales, purchases, returns, vouchers (incl. an
 * overpayment advance), expenses, cash movements, ledger legs, stock and a
 * pending sync unit:
 *   1. every table in the backup restores with EXACTLY the same row count;
 *   2. financial / stock checksums are identical (invoice totals & paid,
 *      ledger debit/credit per currency, voucher amounts, roll remaining kg,
 *      expenses, manual movements);
 *   3. un-pushed sync operations survive (pending outbox count).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { round2dp } from "@erp/shared";
import { db, pool } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { returns } from "@/infrastructure/orm/schemas/return.table.js";
import { returnLines } from "@/infrastructure/orm/schemas/return-line.table.js";
import { expenses } from "@/infrastructure/orm/schemas/expense.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { manualMovements } from "@/infrastructure/orm/schemas/cashbox.table.js";
import { runTenantFullBackup } from "@/presentation/routes/backup.route.js";
import {
  BackupError,
  DEVICE_BOUND_TABLES,
  openAndVerifyBackup,
  restorePortableBackup,
} from "@/infrastructure/backup/portableBackup.js";

const tenantId = randomUUID();
const targetTenantId = randomUUID();
const cust = randomUUID();
const supp = randomUUID();
const fab = randomUUID();
const col = randomUUID();
const roll = randomUUID();
const inv = [randomUUID(), randomUUID(), randomUUID()];
const RESTORE_DB = `erp_restore_rt_${process.pid}`;
const work = mkdtempSync(join(tmpdir(), "erp-roundtrip-"));
const zip = join(work, "backup.zip");

function urlFor(dbName: string): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const CHECKSUMS = (t: string) => `
  SELECT
    (SELECT json_object_agg(currency, s) FROM (SELECT currency, sum(total)::text || '/' || sum(paid)::text AS s
        FROM invoices WHERE tenant_id = '${t}' GROUP BY currency) x) AS invoices,
    (SELECT json_object_agg(currency, s) FROM (SELECT currency, sum(debit)::text || '/' || sum(credit)::text AS s
        FROM ledger_entries WHERE tenant_id = '${t}' GROUP BY currency) x) AS ledger,
    (SELECT sum(amount)::text FROM vouchers WHERE tenant_id = '${t}') AS vouchers,
    (SELECT sum(remaining_kg)::text FROM rolls WHERE tenant_id = '${t}') AS stock,
    (SELECT sum(amount)::text FROM expenses WHERE tenant_id = '${t}') AS expenses,
    (SELECT sum(amount)::text FROM manual_movements WHERE tenant_id = '${t}') AS cash,
    (SELECT count(*)::int FROM sync_outbox WHERE tenant_id = '${t}' AND status IN ('pending','pushing')) AS pending`;

let restored: pg.Pool;

beforeAll(async () => {
  // ── source tenant with a realistic mix of documents ──
  await db.insert(tenants).values({ id: tenantId, name: "RT", slug: `rt-${tenantId.slice(0, 8)}` });
  await db.insert(parties).values([
    { id: cust, tenantId, name: "زبون RT", code: "RTC", kind: "customer", currency: "USD" },
    { id: supp, tenantId, name: "مورد RT", code: "RTS", kind: "supplier", currency: "USD" },
  ] as never);
  await db.insert(fabrics).values({ id: fab, tenantId, name: "قماش RT" } as never);
  await db.insert(colors).values({ id: col, tenantId, fabricId: fab, name: "أزرق" } as never);
  await db.insert(rolls).values({
    id: roll, tenantId, colorId: col, rollNo: `RT-${tenantId.slice(0, 6)}`, initialKg: "100",
    remainingKg: "71.5", pricePerKg: "2.5", currency: "USD", entryDate: "2026-07-01", pieces: 3, remainingPieces: 2,
  } as never);
  const docs = [
    { id: inv[0]!, type: "entry", party: supp, total: 250, paid: 100, qty: 100, price: 2.5 },
    { id: inv[1]!, type: "sale", party: cust, total: 95, paid: 95, qty: 10, price: 10 },
    { id: inv[2]!, type: "sale", party: cust, total: 187.25, paid: 50, qty: 18.5, price: 10.5 },
  ];
  for (const [n, d] of docs.entries()) {
    await db.insert(invoices).values({
      id: d.id, tenantId, number: `RT-${n}-${tenantId.slice(0, 4)}`, type: d.type, date: "2026-07-0" + (n + 1),
      partyId: d.party, partyType: d.type === "sale" ? "customer" : "supplier", currency: "USD", exchangeRate: 1,
      subtotal: d.total, total: d.total, paid: d.paid, status: "active",
    } as never);
    await db.insert(invoiceLines).values({
      id: randomUUID(), tenantId, invoiceId: d.id, fabricId: fab, colorId: col, rollId: roll,
      quantityKg: String(d.qty), pricePerKg: String(d.price), discountAmount: "0",
      lineTotal: String(round2dp(d.qty * d.price)),
    } as never);
  }
  const ret = randomUUID();
  await db.insert(returns).values({
    id: ret, tenantId, number: `RT-R-${tenantId.slice(0, 4)}`, kind: "sale", date: "2026-07-05",
    partyId: cust, originalInvoiceId: inv[2]!, reason: "defect", currency: "USD",
  } as never);
  await db.insert(returnLines).values({ id: randomUUID(), tenantId, returnId: ret, rollId: roll, quantityKg: "1.5", pricePerKg: "10.5" } as never);
  await db.insert(vouchers).values([
    { tenantId, kind: "receipt", number: `RT-V1-${tenantId.slice(0, 4)}`, date: "2026-07-02", partyId: cust, partyKind: "customer", invoiceId: inv[1]!, amount: 95, currency: "USD", method: "cash", appliedAmount: 95 },
    { tenantId, kind: "receipt", number: `RT-V2-${tenantId.slice(0, 4)}`, date: "2026-07-03", partyId: cust, partyKind: "customer", invoiceId: inv[2]!, amount: 70, currency: "USD", method: "cash", appliedAmount: 50 },
    { tenantId, kind: "payment", number: `RT-V3-${tenantId.slice(0, 4)}`, date: "2026-07-01", partyId: supp, partyKind: "supplier", invoiceId: inv[0]!, amount: 100, currency: "USD", method: "cash" },
  ] as never);
  await db.insert(ledgerEntries).values([
    { tenantId, partyId: cust, date: "2026-07-02", type: "sales_invoice", debit: 95, credit: 0, currency: "USD" },
    { tenantId, partyId: cust, date: "2026-07-03", type: "receipt_in", debit: 0, credit: 70, currency: "USD", cashImpact: "in" },
    { tenantId, partyId: supp, date: "2026-07-01", type: "purchase_invoice", debit: 0, credit: 250, currency: "USD" },
    { tenantId, partyId: null, date: "2026-07-04", type: "expense", debit: 12.75, credit: 0, currency: "SYP" },
  ] as never);
  await db.insert(expenses).values({
    id: randomUUID(), tenantId, number: `RT-E-${tenantId.slice(0, 4)}`, category: "نقل", description: "شحن",
    amount: 12.75, currency: "SYP", date: "2026-07-04", method: "cash",
  } as never);
  await db.insert(manualMovements).values({
    tenantId, date: "2026-07-04", type: "capital", direction: "in", amount: 500, currency: "USD", description: "إيداع",
  } as never);
  await pool.query(
    `INSERT INTO sync_outbox (tenant_id, op_id, entity_type, entity_id, operation, payload, status)
     VALUES ($1, $2, 'invoice', $3, 'create', '{}'::jsonb, 'pending')`,
    [tenantId, randomUUID(), inv[2]],
  );

  // ── target database: fresh schema only ──
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
  await admin.query(`CREATE DATABASE ${RESTORE_DB}`);
  await admin.end();
  restored = new pg.Pool({ connectionString: urlFor(RESTORE_DB) });
  await migrate(drizzle(restored), {
    migrationsFolder: resolve(__dirname, "../src/infrastructure/orm/migrations"),
  });
  // The restoring install's own company row (a fresh desktop has one baked in).
  await restored.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'target', $2)`, [
    targetTenantId,
    `tg-${targetTenantId.slice(0, 8)}`,
  ]);
}, 180_000);

afterAll(async () => {
  await restored?.end();
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
});

const MIGRATIONS = resolve(__dirname, "../src/infrastructure/orm/migrations");

describe("backup → restore round trip", () => {
  it("backs up every company table except device-bound ones, incl. cashbox/financial/sync state", async () => {
    const backup = await runTenantFullBackup(tenantId, zip);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    const names = backup.manifest.tables.map((t) => t.name);
    for (const t of [
      "invoices", "ledger_entries", "cashbox_daily_balances", "financial_operations",
      "setup_wizard_state", "sync_outbox", "sync_inbox", "sync_state", "sync_devices",
    ]) {
      expect(names, `backup must include ${t}`).toContain(t);
    }
    for (const t of DEVICE_BOUND_TABLES) expect(names, `${t} is machine-bound`).not.toContain(t);
    expect(backup.manifest.schema.migrationsApplied).toBeGreaterThan(80);
  }, 180_000);

  it("rejects a tampered archive before touching any database", async () => {
    const e = unzipSync(new Uint8Array(readFileSync(zip)));
    e["data/invoices.ndjson"] = strToU8(strFromU8(e["data/invoices.ndjson"]!).replace("187.25", "187.26"));
    const bad = join(work, "tampered.zip");
    writeFileSync(bad, zipSync(e));
    await expect(openAndVerifyBackup(bad)).rejects.toMatchObject({ code: "BACKUP_CORRUPT" });
    await expect(openAndVerifyBackup(bad)).rejects.toBeInstanceOf(BackupError);
  });

  it("restores every row and every total exactly, under another company id", async () => {
    const report = await restorePortableBackup({
      databaseUrl: urlFor(RESTORE_DB),
      migrationsFolder: MIGRATIONS,
      file: zip,
      targetTenantId,
      confirmReplace: false,
    });
    expect(report.ok).toBe(true);
    expect(report.schema.migratedDuringRestore).toBe(0);
    expect(report.tables.every((t) => t.verified === "sha256")).toBe(true);

    // 1. row counts per backed-up table
    const { manifest } = await openAndVerifyBackup(zip);
    for (const t of manifest.tables) {
      const q = await restored.query(`SELECT count(*)::int AS n FROM "${t.name}" WHERE tenant_id = $1`, [
        targetTenantId,
      ]);
      expect({ table: t.name, n: q.rows[0].n }).toEqual({ table: t.name, n: t.rows });
    }

    // 2. financial + stock checksums identical
    const src = (await pool.query(CHECKSUMS(tenantId))).rows[0];
    const dst = (await restored.query(CHECKSUMS(targetTenantId))).rows[0];
    expect(dst).toEqual(src);
    expect(src.invoices).not.toBeNull();
    expect(src.stock).toBe("71.50");
    // 3. un-pushed sync work survived
    expect(src.pending).toBe(1);

    // 4. sequences were advanced: a new outbox unit sorts AFTER the restored one
    const maxSeq = (await restored.query(`SELECT max(seq)::bigint AS m FROM sync_outbox`)).rows[0].m;
    const ins = await restored.query(
      `INSERT INTO sync_outbox (tenant_id, op_id, entity_type, entity_id, operation, payload, status)
       VALUES ($1, $2, 'invoice', $3, 'create', '{}'::jsonb, 'pending') RETURNING seq`,
      [targetTenantId, randomUUID(), randomUUID()],
    );
    expect(BigInt(ins.rows[0].seq)).toBeGreaterThan(BigInt(maxSeq));
  }, 180_000);

  it("refuses to replace existing data without explicit confirmation", async () => {
    await expect(
      restorePortableBackup({
        databaseUrl: urlFor(RESTORE_DB),
        migrationsFolder: MIGRATIONS,
        file: zip,
        targetTenantId,
        confirmReplace: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORE_CONFIRM_REQUIRED" });
  }, 180_000);
});
