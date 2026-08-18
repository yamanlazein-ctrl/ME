/**
 * Fix invoice line discountAmount from percentage to fixed values.
 * Then recalculate invoice subtotals/totals and update ledger entries.
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and, inArray } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";
import { vouchers } from "../src/infrastructure/orm/schemas/voucher.table.js";

const TENANT_ID = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const USER_ID = "11111111-1111-1111-1111-111111111111";

// Map: invoice number -> array of fixed discountAmount per line (in order)
const FIXED_DISCOUNTS: Record<string, number[]> = {
  "INV-2026-0007": [10000],
  "INV-2026-0008": [5000, 4000],
  "INV-2026-0009": [20000],
  "INV-2026-0010": [8000, 6000],
  "INV-2026-0011": [15000],
};

async function main() {
  for (const [num, discounts] of Object.entries(FIXED_DISCOUNTS)) {
    console.log(`\n========== ${num} ==========`);
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) {
      console.log("  NOT FOUND");
      continue;
    }
    const inv = invRows[0];

    // 1. Get lines in order
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.createdAt);
    if (lines.length !== discounts.length) {
      console.log(`  MISMATCH: ${lines.length} lines vs ${discounts.length} discounts`);
      continue;
    }

    // 2. Update each line with fixed discount
    let computedSubtotal = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const newDiscount = discounts[i];
      await db
        .update(invoiceLines)
        .set({ discountAmount: newDiscount })
        .where(eq(invoiceLines.id, l.id));
      const lineTotal = Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - newDiscount);
      computedSubtotal += lineTotal;
      console.log(`  Line ${i + 1}: discountAmount ${l.discountAmount} -> ${newDiscount}, lineTotal=${lineTotal}`);
    }

    // 3. Recalculate invoice totals
    const newTotal = computedSubtotal - Number(inv.discount) + Number(inv.tax) + Number(inv.shipping);
    await db
      .update(invoices)
      .set({
        subtotal: computedSubtotal,
        total: newTotal,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, inv.id));
    console.log(`  Invoice: subtotal=${computedSubtotal}, total=${newTotal}`);

    // 4. Update ledger entries for purchase_invoice (party leg = debit newTotal, inventory leg = credit newTotal)
    const invLedgers = await db
      .select()
      .from(ledgerEntries)
      .where(and(
        eq(ledgerEntries.referenceId, inv.id),
        eq(ledgerEntries.referenceType, "purchase_invoice"),
        eq(ledgerEntries.status, "active"),
      ));
    for (const le of invLedgers) {
      if (le.type === "purchase_invoice") {
        await db.update(ledgerEntries).set({ debit: newTotal }).where(eq(ledgerEntries.id, le.id));
        console.log(`  Updated purchase_invoice ledger debit=${newTotal}`);
      } else if (le.type === "inventory_asset") {
        await db.update(ledgerEntries).set({ credit: newTotal }).where(eq(ledgerEntries.id, le.id));
        console.log(`  Updated inventory_asset ledger credit=${newTotal}`);
      }
    }

    // 5. Update linked payment voucher amount if paid > newTotal
    const paid = Number(inv.paid);
    if (paid > newTotal) {
      console.log(`  WARNING: paid (${paid}) > newTotal (${newTotal}). Clamping paid to ${newTotal}.`);
      await db.update(invoices).set({ paid: newTotal }).where(eq(invoices.id, inv.id));
      // Update payment voucher and ledger entries
      const payVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.invoiceId, inv.id), eq(vouchers.kind, "payment"), eq(vouchers.status, "active")));
      for (const v of payVouchers) {
        await db.update(vouchers).set({ amount: newTotal }).where(eq(vouchers.id, v.id));
        const vLedgers = await db
          .select()
          .from(ledgerEntries)
          .where(and(eq(ledgerEntries.referenceId, v.id), eq(ledgerEntries.status, "active")));
        for (const vl of vLedgers) {
          if (vl.type === "payment_out") {
            await db.update(ledgerEntries).set({ credit: newTotal }).where(eq(ledgerEntries.id, vl.id));
          } else if (vl.type === "cash") {
            await db.update(ledgerEntries).set({ debit: newTotal }).where(eq(ledgerEntries.id, vl.id));
          }
        }
      }
    }
  }

  // ===== FINAL REPORT =====
  console.log("\n\n========== FINAL SYSTEM REPORT ==========");
  for (const num of Object.keys(FIXED_DISCOUNTS)) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));

    console.log(`\n--- ${num} ---`);
    let lineIdx = 1;
    let computedSubtotal = 0;
    for (const l of lines) {
      const lineTotal = Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0));
      computedSubtotal += lineTotal;
      console.log(`  Line ${lineIdx}: qty=${l.quantityKg} × price=${l.pricePerKg} - discount=${l.discountAmount} = ${lineTotal}`);
      lineIdx++;
    }
    console.log(`  Subtotal (system):  ${inv.subtotal}`);
    console.log(`  Discount:           ${inv.discount}`);
    console.log(`  Tax:                ${inv.tax}`);
    console.log(`  Shipping:           ${inv.shipping}`);
    console.log(`  Total (system):     ${inv.total}`);
    console.log(`  Paid:               ${inv.paid}`);
    console.log(`  Payment Method:     ${inv.paymentMethod ?? "null"}`);
    console.log(`  Amount Due:         ${Number(inv.total) - Number(inv.paid)}`);
  }

  // Supplier balances
  console.log("\n\n========== SUPPLIER BALANCES ==========");
  for (const num of Object.keys(FIXED_DISCOUNTS)) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    const balanceRows = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partyId, inv.partyId), eq(ledgerEntries.status, "active")));
    const debit = balanceRows.reduce((s, r) => s + Number(r.debit ?? 0), 0);
    const credit = balanceRows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
    console.log(`  ${num}: debit=${debit}, credit=${credit}, net=${debit - credit}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
