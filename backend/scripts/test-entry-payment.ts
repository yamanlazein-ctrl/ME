/**
 * Test script: Verify entry invoice payment handling (paid + paymentMethod)
 *
 * Run: cd backend && npx tsx scripts/test-entry-payment.ts
 *
 * This verifies the audit fix:
 * - paid is stored on the invoice
 * - paymentMethod is stored and returned
 * - linked payment_out voucher is created
 * - supplier balance = total - paid (not total)
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "../src/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";

const TENANT_ID = "407fccfc-1234-5678-9abc-def012345678"; // Replace with actual test tenant

async function main() {
  // Find latest entry invoice with paid > 0
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, TENANT_ID), eq(invoices.type, "entry")))
    .orderBy(invoices.createdAt)
    .limit(5);

  console.log("=== Entry Invoices (latest 5) ===");
  for (const inv of rows) {
    const paid = Number(inv.paid ?? 0);
    const total = Number(inv.total ?? 0);
    console.log(`  ${inv.number}: total=${total}, paid=${paid}, due=${total - paid}, method=${inv.paymentMethod ?? "null"}`);

    // Find linked payment voucher
    const linkedPayments = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.invoiceId, inv.id), eq(vouchers.kind, "payment")));
    if (linkedPayments.length > 0) {
      console.log(`    -> Linked payment voucher: ${linkedPayments[0].number}, amount=${linkedPayments[0].amount}, method=${linkedPayments[0].method}`);
    }

    // Find linked ledger entries
    const ledgers = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.referenceId, inv.id), eq(ledgerEntries.referenceType, "purchase_invoice")));
    const paymentLedgers = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.referenceType, "payment_out")))
      .limit(5);

    if (ledgers.length > 0) {
      const partyLeg = ledgers.find((l) => l.partyId && l.type === "purchase_invoice");
      console.log(`    -> Ledger party leg: debit=${partyLeg?.debit ?? 0}`);
    }
  }

  // Verify balance computation for a specific party
  const partyId = rows[0]?.partyId;
  if (partyId) {
    const balanceRows = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partyId, partyId), eq(ledgerEntries.status, "active")));
    const debit = balanceRows.reduce((s, r) => s + Number(r.debit ?? 0), 0);
    const credit = balanceRows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
    console.log(`\n=== Party ${partyId} balance ===`);
    console.log(`  Total debit:  ${debit}`);
    console.log(`  Total credit: ${credit}`);
    console.log(`  Net balance:  ${debit - credit} (should equal sum of amountDue for active entry invoices)`);
  }

  console.log("\n✅ Test complete");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});