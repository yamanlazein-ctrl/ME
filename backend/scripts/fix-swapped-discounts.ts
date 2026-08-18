/**
 * Fix swapped discounts on INV-2026-0008 by matching on qty+price.
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";

async function main() {
  const invRows = await db.select().from(invoices).where(eq(invoices.number, "INV-2026-0008")).limit(1);
  if (invRows.length === 0) { console.log("NOT FOUND"); process.exit(0); }
  const inv = invRows[0];

  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
  for (const l of lines) {
    const qty = Number(l.quantityKg);
    const price = Number(l.pricePerKg);
    let correctDiscount: number;
    if (qty === 110 && price === 3200) {
      correctDiscount = 5000;
    } else if (qty === 85 && price === 3500) {
      correctDiscount = 4000;
    } else {
      continue;
    }
    await db.update(invoiceLines).set({ discountAmount: correctDiscount }).where(eq(invoiceLines.id, l.id));
    console.log(`Updated line qty=${qty} price=${price} -> discount=${correctDiscount}`);
  }

  // Recalculate totals
  const updatedLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
  let subtotal = 0;
  for (const l of updatedLines) {
    subtotal += Math.round(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount));
  }
  const total = subtotal - Number(inv.discount) + Number(inv.tax) + Number(inv.shipping);
  await db.update(invoices).set({ subtotal, total }).where(eq(invoices.id, inv.id));
  console.log(`Invoice updated: subtotal=${subtotal}, total=${total}`);

  // Update ledger
  const ledgers = await db.select().from(ledgerEntries).where(and(
    eq(ledgerEntries.referenceId, inv.id),
    eq(ledgerEntries.referenceType, "purchase_invoice"),
    eq(ledgerEntries.status, "active"),
  ));
  for (const le of ledgers) {
    if (le.type === "purchase_invoice") {
      await db.update(ledgerEntries).set({ debit: total }).where(eq(ledgerEntries.id, le.id));
    } else if (le.type === "inventory_asset") {
      await db.update(ledgerEntries).set({ credit: total }).where(eq(ledgerEntries.id, le.id));
    }
  }
  console.log("Ledger updated.");

  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
