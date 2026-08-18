/**
 * Recreate the 5 entry invoices with correct paid amounts.
 * Steps:
 * 1. Cancel existing invoices (reverses stock + cancels ledger entries)
 * 2. Re-create with correct paid + paymentMethod
 * 3. Print computed results
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq } from "drizzle-orm";
import { PostgresInvoiceRepository } from "../src/infrastructure/repositories/PostgresInvoiceRepository.js";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "../src/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "../src/infrastructure/orm/schemas/color.table.js";
import { rolls } from "../src/infrastructure/orm/schemas/roll.table.js";
import { vouchers } from "../src/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";
import type { TenantContext } from "../src/domain/types/index.js";

const TENANT_ID = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const USER_ID = "11111111-1111-1111-1111-111111111111"; // system user

const ctx: TenantContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  userRole: "admin",
  userName: "system",
};

const repo = new PostgresInvoiceRepository(db);

const INV_NUMBERS = ["INV-2026-0007","INV-2026-0008","INV-2026-0009","INV-2026-0010","INV-2026-0011"];

// Desired values extracted from notes
const DESIRED_PAID: Record<string, { paid: number; method: "cash" | "transfer" | "check" | "card" }> = {
  "INV-2026-0007": { paid: 200000, method: "cash" },
  "INV-2026-0008": { paid: 0, method: "cash" },
  "INV-2026-0009": { paid: 300000, method: "cash" },
  "INV-2026-0010": { paid: 150000, method: "check" },
  "INV-2026-0011": { paid: 250000, method: "cash" },
};

async function main() {
  for (const num of INV_NUMBERS) {
    console.log(`\n========== ${num} ==========`);
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) {
      console.log("  NOT FOUND, skipping");
      continue;
    }
    const inv = invRows[0];

    // 1. Cancel existing invoice (reverses stock, cancels ledger entries)
    if (inv.status !== "cancelled") {
      console.log("  Cancelling existing invoice...");
      await repo.cancel(inv.id, USER_ID, ctx);
      console.log("  Cancelled.");
    } else {
      console.log("  Already cancelled.");
    }

    // 2. Gather line data from cancelled invoice
    const oldLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const lines = [];
    for (const l of oldLines) {
      const rol = await db.select().from(rolls).where(eq(rolls.id, l.rollId)).limit(1);
      lines.push({
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: Number(l.quantityKg),
        pieces: Number(l.pieces ?? 1),
        pricePerKg: Number(l.pricePerKg),
        discountAmount: Number(l.discountAmount ?? 0),
        note: l.note ?? undefined,
      });
    }

    // 3. Re-create with correct paid amount
    const desired = DESIRED_PAID[num];
    const createInput = {
      type: "entry" as const,
      date: inv.date,
      partyId: inv.partyId,
      partyType: "supplier" as const,
      currency: inv.currency,
      lines,
      discount: Number(inv.discount),
      tax: Number(inv.tax),
      shipping: Number(inv.shipping),
      notes: inv.notes ?? undefined,
      paid: desired.paid,
      paymentMethod: desired.paid > 0 ? desired.method : undefined,
    };

    console.log(`  Re-creating with paid=${desired.paid}, method=${desired.method}...`);
    const newInv = await repo.create(createInput, num, ctx);
    console.log(`  Re-created: ${newInv.number}`);
    console.log(`    total=${newInv.total}, paid=${newInv.paid}, amountDue=${newInv.amountDue}, paymentMethod=${newInv.paymentMethod ?? "null"}`);

    // 4. Verify linked payment voucher
    if (desired.paid > 0) {
      const payVouchers = await db.select().from(vouchers).where(eq(vouchers.invoiceId, newInv.id));
      for (const v of payVouchers) {
        console.log(`    -> Voucher: ${v.number}, kind=${v.kind}, amount=${v.amount}, method=${v.method}`);
      }
    }
  }

  // 5. Print final summary
  console.log("\n\n========== FINAL SUMMARY ==========");
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    if (inv.status === "cancelled") continue;

    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));

    console.log(`\n--- ${num} (${party[0]?.name}) ---`);
    console.log(`  paid=${inv.paid}, paymentMethod=${inv.paymentMethod ?? "null"}`);
    let lineIdx = 1;
    let subtotal = 0;
    for (const l of lines) {
      const lineTotal = Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0));
      subtotal += lineTotal;
      console.log(`  Line ${lineIdx}: qty=${l.quantityKg} × price=${l.pricePerKg} - discount=${l.discountAmount} = ${lineTotal}`);
      lineIdx++;
    }
    console.log(`  Subtotal (computed from lines): ${subtotal}`);
    console.log(`  Invoice subtotal (stored):      ${inv.subtotal}`);
    console.log(`  Invoice total (stored):         ${inv.total}`);
    console.log(`  Amount Due:                     ${Number(inv.total) - Number(inv.paid)}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
