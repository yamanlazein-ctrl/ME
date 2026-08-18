/**
 * Final report: read computed values from the system for all 5 entry invoices.
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { vouchers } from "../src/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";

const INV_NUMBERS = [
  "INV-2026-0007","INV-2026-0008","INV-2026-0009","INV-2026-0010","INV-2026-0011",
  "INV-2026-0023","INV-2026-0024","INV-2026-0025","INV-2026-0026","INV-2026-0027",
  "INV-2026-0028","INV-2026-0029","INV-2026-0030","INV-2026-0031","INV-2026-0032",
];

async function main() {
  console.log("========== FINAL SYSTEM REPORT ==========\n");
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    if (inv.status === "cancelled") {
      console.log(`--- ${num}: CANCELLED ---\n`);
      continue;
    }

    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const payVouchers = await db.select().from(vouchers).where(
      and(eq(vouchers.invoiceId, inv.id), eq(vouchers.kind, "payment"), eq(vouchers.status, "active"))
    );

    console.log(`--- ${num} | ${party[0]?.name} ---`);
    console.log(`  Date: ${inv.date}`);
    console.log(`  Reference: ${inv.notes?.split("|")[0]?.trim() ?? ""}`);

    let lineIdx = 1;
    let computedSubtotal = 0;
    for (const l of lines) {
      const lineTotal = Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0));
      computedSubtotal += lineTotal;
      console.log(`  Line ${lineIdx}: qty=${l.quantityKg} × price=${l.pricePerKg} - discount=${l.discountAmount} = ${lineTotal}`);
      lineIdx++;
    }

    console.log(`  Subtotal (system):  ${inv.subtotal}`);
    console.log(`  Invoice Discount:   ${inv.discount}`);
    console.log(`  Tax:                ${inv.tax}`);
    console.log(`  Shipping:           ${inv.shipping}`);
    console.log(`  Total (system):     ${inv.total}`);
    console.log(`  Paid:               ${inv.paid}`);
    console.log(`  Payment Method:     ${inv.paymentMethod ?? "null"}`);
    console.log(`  Amount Due:         ${Number(inv.total) - Number(inv.paid)}`);
    if (payVouchers.length > 0) {
      console.log(`  Linked Voucher:     ${payVouchers[0].number} (${payVouchers[0].method})`);
    }
    console.log("");
  }

  console.log("========== SUPPLIER BALANCES (from ledger) ==========\n");
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    const balanceRows = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partyId, inv.partyId), eq(ledgerEntries.status, "active")));
    const debit = balanceRows.reduce((s, r) => s + Number(r.debit ?? 0), 0);
    const credit = balanceRows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
    console.log(`  ${party[0]?.name}: debit=${debit}, credit=${credit}, net=${debit - credit}`);
  }

  console.log("\n========== DONE ==========");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
