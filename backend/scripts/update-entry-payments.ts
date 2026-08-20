/**
 * Update existing entry invoices with correct paid amounts and create linked payment vouchers/ledger entries.
 */
import { db } from "../src/infrastructure/orm/drizzle.js";
import { eq, and } from "drizzle-orm";
import { invoices } from "../src/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "../src/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "../src/infrastructure/orm/schemas/ledger-entry.table.js";
import { parties } from "../src/infrastructure/orm/schemas/party.table.js";
import { invoiceLines } from "../src/infrastructure/orm/schemas/invoice-line.table.js";

const TENANT_ID = "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const INV_NUMBERS = [
  "INV-2026-0007",
  "INV-2026-0008",
  "INV-2026-0009",
  "INV-2026-0010",
  "INV-2026-0011",
];

const DESIRED_PAID: Record<
  string,
  { paid: number; method: "cash" | "transfer" | "check" | "card" }
> = {
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
      console.log("  NOT FOUND");
      continue;
    }
    const inv = invRows[0];
    const desired = DESIRED_PAID[num];

    if (inv.status === "cancelled") {
      console.log("  SKIPPED (cancelled)");
      continue;
    }

    // 1. Update invoice with correct paid and paymentMethod
    await db
      .update(invoices)
      .set({
        paid: desired.paid,
        paymentMethod: desired.paid > 0 ? desired.method : null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, inv.id));
    console.log(`  Updated paid=${desired.paid}, method=${desired.method ?? "null"}`);

    // 2. If paid > 0, create linked payment voucher and ledger entries
    if (desired.paid > 0) {
      const existingVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.invoiceId, inv.id), eq(vouchers.kind, "payment")));

      if (existingVouchers.length === 0) {
        const paymentNumber = `PAY-${num}`;
        const [voucherRow] = await db
          .insert(vouchers)
          .values({
            tenantId: TENANT_ID,
            kind: "payment",
            number: paymentNumber,
            date: inv.date,
            partyId: inv.partyId,
            partyKind: "supplier",
            invoiceId: inv.id,
            amount: desired.paid,
            currency: inv.currency,
            method: desired.method,
            notesPrint: `دفعة مرتبطة بالفاتورة ${num}`,
            createdBy: USER_ID,
          })
          .returning();
        console.log(`  Created payment voucher: ${paymentNumber}, amount=${desired.paid}`);

        const cashImpact = desired.method === "cash" ? "out" : "none";
        await db.insert(ledgerEntries).values([
          {
            tenantId: TENANT_ID,
            partyId: inv.partyId,
            date: inv.date,
            type: "payment_out",
            debit: 0,
            credit: desired.paid,
            currency: inv.currency,
            cashImpact: "none",
            referenceType: "payment_out",
            referenceId: voucherRow.id,
            referenceNumber: paymentNumber,
            description: `Payment ${paymentNumber}`,
            createdBy: USER_ID,
          },
          {
            tenantId: TENANT_ID,
            partyId: null,
            date: inv.date,
            type: "cash",
            debit: desired.paid,
            credit: 0,
            currency: inv.currency,
            cashImpact,
            referenceType: "payment_out",
            referenceId: voucherRow.id,
            referenceNumber: paymentNumber,
            description: `Cash paid ${paymentNumber}`,
            createdBy: USER_ID,
          },
        ]);
        console.log(`  Created ledger entries for payment_out`);
      } else {
        console.log(`  Payment voucher already exists: ${existingVouchers[0].number}`);
      }
    }
  }

  // 3. Print final summary from the system
  console.log("\n\n========== FINAL SYSTEM REPORT ==========");
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    if (inv.status === "cancelled") continue;

    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const payVouchers = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.invoiceId, inv.id), eq(vouchers.kind, "payment")));

    console.log(`\n--- ${num} | ${party[0]?.name} ---`);
    console.log(`  Date: ${inv.date}`);

    let lineIdx = 1;
    let computedSubtotal = 0;
    for (const l of lines) {
      const lineTotal = Math.round(
        Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0),
      );
      computedSubtotal += lineTotal;
      console.log(`  Line ${lineIdx}: ${lineTotal}`);
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
    if (payVouchers.length > 0) {
      console.log(`  Linked Voucher:     ${payVouchers[0].number} (${payVouchers[0].method})`);
    }
  }

  // 4. Supplier balances
  console.log("\n\n========== SUPPLIER BALANCES ==========");
  for (const num of INV_NUMBERS) {
    const invRows = await db.select().from(invoices).where(eq(invoices.number, num)).limit(1);
    if (invRows.length === 0) continue;
    const inv = invRows[0];
    if (inv.status === "cancelled") continue;

    const party = await db.select().from(parties).where(eq(parties.id, inv.partyId)).limit(1);
    const balanceRows = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partyId, inv.partyId), eq(ledgerEntries.status, "active")));
    const debit = balanceRows.reduce((s, r) => s + Number(r.debit ?? 0), 0);
    const credit = balanceRows.reduce((s, r) => s + Number(r.credit ?? 0), 0);
    console.log(`  ${party[0]?.name}: debit=${debit}, credit=${credit}, net=${debit - credit}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
