/**
 * The party statement must show the ACTUAL invoice and the ACTUAL payment, each
 * in its own currency with its own frozen rate, plus the converted equivalent
 * that reduced the balance. The invoice must survive the payment untouched.
 *
 *   Invoice 136,500 SYP (historical rate 13,000)  ->  balance 136,500 SYP
 *   Receipt 10 USD @ 13,650 (rate at payment)      ->  equivalent 136,500 SYP -> balance 0
 *
 * Rates use realistic SYP/USD magnitudes (>= 1,000) — anything below that is
 * rejected by the saneSypRateError guard as a likely dropped-zero typo.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { computeBaseEquivalent } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "stmt-doc-tester",
};

async function insertInvoice(opts: {
  number: string;
  total: number;
  currency: string;
  exchangeRate: number;
  kind: "sale" | "entry";
}) {
  const id = randomUUID();
  const isSale = opts.kind === "sale";
  const partyId = isSale ? customerId : supplierId;
  const base = computeBaseEquivalent(opts.total, opts.currency, opts.exchangeRate);
  await db.insert(invoices).values({
    id,
    tenantId,
    number: opts.number,
    type: opts.kind,
    date: "2026-09-21",
    partyId,
    partyType: isSale ? "customer" : "supplier",
    currency: opts.currency,
    subtotal: opts.total,
    total: opts.total,
    paid: 0,
    exchangeRate: opts.exchangeRate,
    baseTotal: base,
  });
  await db.insert(ledgerEntries).values({
    tenantId,
    partyId,
    date: "2026-09-21",
    type: isSale ? "sales_invoice" : "purchase_invoice",
    debit: isSale ? opts.total : 0,
    credit: isSale ? 0 : opts.total,
    currency: opts.currency,
    exchangeRate: opts.exchangeRate,
    baseDebit: isSale ? base : 0,
    baseCredit: isSale ? 0 : base,
    cashImpact: "none",
    referenceType: isSale ? "sales_invoice" : "purchase_invoice",
    referenceId: id,
    referenceNumber: opts.number,
    description: opts.number,
    createdBy: ctx.userId,
  });
  return id;
}

describe("statement shows invoice AND payment with their own currency / rate", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({
      id: tenantId,
      name: "Stmt Doc Tenant",
      slug: `sd-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values([
      { id: customerId, tenantId, name: "Doc Customer", code: "DC-1", kind: "customer", currency: "SYP" },
      { id: supplierId, tenantId, name: "Doc Supplier", code: "DS-1", kind: "supplier", currency: "SYP" },
    ]);
  });

  it("customer: 10 USD @13,650 against a 136,500 SYP invoice -> 0 SYP, both rows visible", async () => {
    const vouchers = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    const invId = await insertInvoice({
      number: "INV-DOC-1",
      total: 136_500,
      currency: "SYP",
      exchangeRate: 13_000,
      kind: "sale",
    });

    const receipt = await vouchers.create(
      {
        kind: "receipt",
        date: "2026-09-21",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invId,
        amount: 10,
        currency: "USD",
        exchangeRate: 13_650,
        method: "cash",
      },
      ctx,
    );

    // Invoice untouched: original currency, amount and historical rate.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(inv.currency).toBe("SYP");
    expect(Number(inv.total)).toBe(136_500);
    expect(Number(inv.exchangeRate)).toBe(13_000);
    expect(Number(inv.paid)).toBe(136_500);

    const stmt = await statements.getStatement(
      { partyId: customerId, kind: "customer", currency: "ALL" },
      ctx,
    );
    const invoiceRow = stmt.entries.find((e) => e.referenceNumber === "INV-DOC-1")!;
    const paymentRow = stmt.entries.find((e) => e.referenceNumber === receipt.number)!;

    // The invoice does not disappear after payment.
    expect(invoiceRow).toBeDefined();
    expect(invoiceRow.debit).toBe(136_500);
    expect(invoiceRow.document).toMatchObject({
      kind: "invoice",
      number: "INV-DOC-1",
      currency: "SYP",
      amount: 136_500,
      exchangeRate: 13_000,
    });

    // Payment: own currency / amount / rate; the row figure is the converted equivalent.
    expect(paymentRow.currency).toBe("SYP");
    expect(paymentRow.credit).toBe(136_500);
    expect(paymentRow.document).toMatchObject({
      kind: "voucher",
      number: receipt.number,
      currency: "USD",
      amount: 10,
      exchangeRate: 13_650,
      crossCurrency: true,
      appliedToInvoiceNumber: "INV-DOC-1",
      appliedToInvoiceCurrency: "SYP",
    });
    expect(paymentRow.runningBalance).toBe(0);
    expect(stmt.totalsByCurrency?.SYP?.finalBalance).toBe(0);
  });

  it("customer: a payment left on account stays a separate USD credit and says so", async () => {
    const vouchers = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    const receipt = await vouchers.create(
      {
        kind: "receipt",
        date: "2026-09-21",
        partyId: customerId,
        partyKind: "customer",
        amount: 5,
        currency: "USD",
        method: "cash",
      },
      ctx,
    );
    const stmt = await statements.getStatement(
      { partyId: customerId, kind: "customer", currency: "ALL" },
      ctx,
    );
    const row = stmt.entries.find((e) => e.referenceNumber === receipt.number)!;
    expect(row.currency).toBe("USD");
    expect(row.credit).toBe(5);
    expect(row.document?.appliedToInvoiceNumber).toBeUndefined();
    expect(row.document?.crossCurrency).toBe(false);
    // SYP account is untouched by an on-account USD payment.
    expect(stmt.totalsByCurrency?.SYP?.finalBalance).toBe(0);
    expect(stmt.totalsByCurrency?.USD?.finalBalance).toBe(-5);
  });

  it("supplier: 10 USD cash + 1 discount @1200 against SYP purchase → 13,200 SYP AP reduction", async () => {
    const vouchers = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    // Fund the USD cashbox (negative cash is allowed, but keep the fixture funded).
    await vouchers.create(
      {
        kind: "receipt",
        date: "2026-09-21",
        partyId: customerId,
        partyKind: "customer",
        amount: 100,
        currency: "USD",
        method: "cash",
      },
      ctx,
    );
    const invId = await insertInvoice({
      number: "ENT-DOC-1",
      total: 1_000_000,
      currency: "SYP",
      exchangeRate: 134,
      kind: "entry",
    });
    const payment = await vouchers.create(
      {
        kind: "payment",
        date: "2026-09-21",
        partyId: supplierId,
        partyKind: "supplier",
        invoiceId: invId,
        amount: 10, // CASH only
        discount: 1, // discount received — additive
        currency: "USD",
        exchangeRate: 1200,
        method: "cash",
      },
      ctx,
    );
    const stmt = await statements.getStatement(
      { partyId: supplierId, kind: "supplier", currency: "ALL" },
      ctx,
    );
    const row = stmt.entries.find((e) => e.referenceNumber === payment.number)!;
    // Party leg is in invoice currency at (cash+discount)×rate = 11×1200.
    expect(row.currency).toBe("SYP");
    expect(row.debit).toBe(13_200);
    expect(row.document).toMatchObject({
      kind: "voucher",
      currency: "USD",
      // Stored voucher.amount is partySettlement (cash+discount); cash = amount−discount.
      amount: 11,
      discount: 1,
      exchangeRate: 1200,
      crossCurrency: true,
      appliedToInvoiceNumber: "ENT-DOC-1",
    });
    expect(stmt.totalsByCurrency?.SYP?.finalBalance).toBe(1_000_000 - 13_200);

    // Cashbox moved by cash only (10), never 10−1=9.
    const [cashLeg] = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.referenceId, payment.id),
          eq(ledgerEntries.type, "cash"),
        ),
      );
    expect(Number(cashLeg.credit)).toBe(10);
    expect(cashLeg.currency).toBe("USD");
  });
});
