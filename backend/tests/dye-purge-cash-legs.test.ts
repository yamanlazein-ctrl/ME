/**
 * The dye cascade purge must take the CASH legs with it.
 *
 * A voucher's ledger legs are keyed by the VOUCHER id, not the invoice id
 * (`CreateReceiptVoucherUseCase` writes `referenceType: "receipt_in" |
 * "payment_out"` with `referenceId: voucherRow.id`). An earlier version of the
 * purge matched ledger rows on INVOICE ids only, so every receipt/payment leg
 * survived as an orphan. Because the drawer is rebuilt from `ledger_entries`, the
 * cashbox then kept cash for an invoice that no longer existed — the exact
 * corruption this feature exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "@/infrastructure/orm/tenant-context.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import {
  computeDyePurgeImpact,
  purgeDyeCascade,
} from "@/infrastructure/repositories/dyePurgeRepository.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const rollId = randomUUID();
const invoiceId = randomUUID();
const voucherId = randomUUID();
const customerId = randomUUID();
const PAID = 100_000;

let reachable = false;

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await runWithTenantContext({ tenantId }, seedAll);
});

/**
 * The whole chain a purge cascades through. Re-runnable: the atomicity test
 * needs a fresh copy because the test above deliberately purges it away.
 */
async function seedAll(): Promise<void> {
  // `slug` is NOT NULL + unique on tenants, so the seed must supply it.
  await db
    .insert(tenants)
    .values({ id: tenantId, name: `purge-${tenantId.slice(0, 8)}`, slug: `purge-${tenantId.slice(0, 8)}` } as never)
    .onConflictDoNothing();
  await db
    .insert(parties)
    .values({
      id: customerId,
      tenantId,
      kind: "customer",
      name: `P-${customerId.slice(0, 8)}`,
      openingBalance: 0,
    } as never)
    .onConflictDoNothing();
  await db
    .insert(fabrics)
    .values({ id: fabricId, tenantId, name: "قماش-تصفيقي" } as never)
    .onConflictDoNothing();
  await db
    .insert(colors)
    .values({ id: colorId, tenantId, fabricId, name: "أحمر", code: "R1" } as never)
    .onConflictDoNothing();
  // `initial_kg` / `remaining_kg` / `price_per_kg` / `entry_date` are NOT NULL.
  await db
    .insert(rolls)
    .values({
      id: rollId,
      tenantId,
      colorId,
      rollNo: 9001,
      initialKg: "100",
      remainingKg: "100",
      pieces: 1,
      remainingPieces: 1,
      pricePerKg: "500",
      currency: "SYP",
      entryDate: "2026-01-05",
      status: "in_stock",
    } as never)
    .onConflictDoNothing();
  await db
    .insert(invoices)
    .values({
      id: invoiceId,
      tenantId,
      number: "SAL-1",
      type: "sale",
      date: "2026-02-01",
      partyId: customerId,
      partyType: "customer",
      currency: "SYP",
      subtotal: PAID,
      total: PAID,
      paid: PAID,
      status: "active",
    } as never)
    .onConflictDoNothing();
  await db
    .insert(invoiceLines)
    .values({
      tenantId,
      invoiceId,
      fabricId,
      colorId,
      rollId,
      quantityKg: 10,
      pricePerKg: 10_000,
      amount: PAID,
    } as never)
    .onConflictDoNothing();
  await db
    .insert(vouchers)
    .values({
      id: voucherId,
      tenantId,
      kind: "receipt",
      number: "RCP-1",
      date: "2026-02-01",
      partyId: customerId,
      partyKind: "customer",
      invoiceId,
      amount: PAID,
      currency: "SYP",
      method: "cash",
      status: "active",
    } as never)
    .onConflictDoNothing();
  await seedLedgerLegs();
}

/**
 * The legs the invoice-create path writes for a cash-paid sale. The cash leg
 * (cash_impact = in) is what actually moves the drawer, and it is keyed by the
 * VOUCHER — not the invoice.
 */
async function seedLedgerLegs(): Promise<void> {
  await db.insert(ledgerEntries).values([
    {
      tenantId,
      partyId: customerId,
      date: "2026-02-01",
      type: "receipt_in",
      debit: 0,
      credit: PAID,
      currency: "SYP",
      cashImpact: "none",
      referenceType: "receipt_in",
      referenceId: voucherId,
      referenceNumber: "RCP-1",
      description: "سند قبض RCP-1",
    },
    {
      tenantId,
      date: "2026-02-01",
      type: "cash",
      debit: PAID,
      credit: 0,
      currency: "SYP",
      cashImpact: "in",
      referenceType: "receipt_in",
      referenceId: voucherId,
      referenceNumber: "RCP-1",
      description: "نقدية مقبوضة RCP-1",
    },
    {
      tenantId,
      partyId: customerId,
      date: "2026-02-01",
      type: "sales_invoice",
      debit: PAID,
      credit: 0,
      currency: "SYP",
      cashImpact: "none",
      referenceType: "sales_invoice",
      referenceId: invoiceId,
      referenceNumber: "SAL-1",
      description: "فاتورة بيع SAL-1",
    },
  ] as never);
}

async function cleanup(): Promise<void> {
  // `ledger_entries` is append-only: the trigger RAISEs on DELETE. The teardown
  // lifts it and restores it in a `finally`, so a mid-teardown failure can never
  // leave the database without its append-only guarantee.
  await db.execute(
    sql`DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries`,
  );
  try {
    for (const stmt of [
      sql`DELETE FROM ledger_entries WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM invoice_lines WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM vouchers WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM invoices WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM stock_movements WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM rolls WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM colors WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM fabrics WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM cashbox_daily_balances WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM parties WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`,
    ]) {
      await db.execute(stmt);
    }
  } finally {
    await db.execute(sql`
      CREATE OR REPLACE TRIGGER trg_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()`);
  }
}

afterAll(async () => {
  if (!reachable) return;
  await cleanup();
});

/** Cash legs still pointing at a voucher whose invoice no longer exists. */
async function orphanCashLegs(): Promise<number> {
  // db.execute() resolves to a QueryResult ({ rows }), not a bare array.
  const res = (await db.execute(sql`
    SELECT count(*)::int AS n
      FROM ledger_entries l
      JOIN vouchers v ON v.id = l.reference_id
     WHERE l.tenant_id = ${tenantId}::uuid
       AND l.reference_type IN ('receipt_in','payment_out')
       AND v.invoice_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = v.invoice_id)
  `)) as unknown as { rows: Array<{ n: number }> };
  return Number(res.rows[0]?.n ?? 0);
}

describe("dye cascade purge — voucher-keyed cash legs", () => {
  it("counts the voucher's cash legs in the dry-run impact", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      const impact = await computeDyePurgeImpact(db, tenantId, fabricId);
      expect(impact.vouchersCount).toBe(1);
      expect(impact.affectedInvoices.map((i) => i.number)).toContain("SAL-1");
      // 3 legs: the invoice leg + the voucher's party leg + the voucher's cash leg.
      expect(impact.ledgerEntriesCount).toBe(3);
      // ONLY the cash leg moves the drawer. Summing every leg showed 3x this.
      expect(impact.cashDelta.syp).toBe(-PAID);
    });
  });

  it("deletes every scoped leg, leaving no orphan cash holding money", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      const result = await purgeDyeCascade(db, tenantId, fabricId, {
        id: randomUUID(),
        name: "purge-tester",
        reason: "regression",
      });

      expect(result.invoicesDeleted).toBe(1);
      expect(result.vouchersDeleted).toBe(1);
      expect(result.ledgerEntriesDeleted).toBe(3);
      expect(result.colorsDeleted).toBe(1);
      expect(result.rollsDeleted).toBe(1);
      expect(result.cashDelta.syp).toBe(-PAID);

      const [left] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.tenantId, tenantId));
      expect(Number(left?.n ?? 0)).toBe(0);
      expect(await orphanCashLegs()).toBe(0);

      const [fabricLeft] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(fabrics)
        .where(and(eq(fabrics.tenantId, tenantId), eq(fabrics.id, fabricId)));
      expect(Number(fabricLeft?.n ?? 0)).toBe(0);
    });
  });

  it("is atomic: an aborted purge leaves the whole chain intact", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    // The purge test above removed the chain, so rebuild it, then force the
    // transaction to abort AFTER the cascade ran. Nothing may survive.
    await seedAll();
    await runWithTenantContext({ tenantId }, async () => {
      await expect(
        db.transaction(async (tx) => {
          await purgeDyeCascade(tx, tenantId, fabricId, { id: randomUUID(), name: "x" });
          throw new Error("forced failure after the cascade ran");
        }),
      ).rejects.toThrow(/forced failure/);

      const [stillThere] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(fabrics)
        .where(and(eq(fabrics.tenantId, tenantId), eq(fabrics.id, fabricId)));
      expect(Number(stillThere?.n ?? 0)).toBe(1);

      const [legs] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.tenantId, tenantId));
      expect(Number(legs?.n ?? 0)).toBe(3);
    });
  });
});

