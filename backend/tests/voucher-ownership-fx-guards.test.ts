/**
 * CODEBASE_AUDIT_REPORT H-01 / H-02 / H-03 — voucher create guards. Engine-agnostic (SQLite + PG).
 *  H-01: a voucher may only settle its OWN party's invoice, in its direction (receipt→sale, payment→entry).
 *  H-02: the party must belong to the voucher's tenant (RLS scopes the voucher row, not the party FK).
 *  H-03: an SYP invoice frozen at one rate settled by an SYP voucher at another must still balance in base.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { computeBaseEquivalent, round2dp } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const customerA = randomUUID();
const customerB = randomUUID();
const supplier = randomUUID();
const foreignParty = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "guard-tester",
};
const repo = new PostgresVoucherRepository(db);
const DATE = "2026-09-16";

async function insertSale(opts: {
  partyId: string;
  total: number;
  currency: string;
  rate: number;
}) {
  const id = randomUUID();
  const base = computeBaseEquivalent(opts.total, opts.currency, opts.rate);
  await db.insert(invoices).values({
    id,
    tenantId,
    number: `INV-${id.slice(0, 8)}`,
    type: "sale",
    date: DATE,
    partyId: opts.partyId,
    partyType: "customer",
    currency: opts.currency,
    subtotal: opts.total,
    total: opts.total,
    paid: 0,
    exchangeRate: opts.rate,
    baseTotal: base,
  });
  return id;
}

const paidOf = async (id: string) =>
  Number(
    (await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, id)))[0]!.paid,
  );

describe("voucher create: ownership, tenant and FX balance guards", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values([
      { id: tenantId, name: "Guard Tenant", slug: `vg-${tenantId.slice(0, 8)}` },
      { id: otherTenantId, name: "Other Tenant", slug: `vg-${otherTenantId.slice(0, 8)}` },
    ]);
    await db.insert(parties).values([
      { id: customerA, tenantId, name: "A", code: "VG-A", kind: "customer", currency: "USD" },
      { id: customerB, tenantId, name: "B", code: "VG-B", kind: "customer", currency: "USD" },
      { id: supplier, tenantId, name: "S", code: "VG-S", kind: "supplier", currency: "USD" },
      {
        id: foreignParty,
        tenantId: otherTenantId,
        name: "X",
        code: "VG-X",
        kind: "customer",
        currency: "USD",
      },
    ]);
  });

  const receipt = (over: Record<string, unknown>) =>
    ({
      kind: "receipt",
      date: DATE,
      partyId: customerA,
      partyKind: "customer",
      amount: 10,
      currency: "USD",
      method: "cash",
      ...over,
    }) as never;

  it("H-01: a receipt for customer B cannot settle customer A's invoice", async () => {
    const inv = await insertSale({ partyId: customerA, total: 100, currency: "USD", rate: 1 });
    await expect(
      repo.create(receipt({ partyId: customerB, invoiceId: inv }), ctx),
    ).rejects.toThrow();
    expect(await paidOf(inv)).toBe(0);
  });

  it("H-01: a payment cannot settle a sale invoice", async () => {
    const inv = await insertSale({ partyId: customerA, total: 100, currency: "USD", rate: 1 });
    await expect(repo.create(receipt({ kind: "payment", invoiceId: inv }), ctx)).rejects.toThrow();
    expect(await paidOf(inv)).toBe(0);
    // The legitimate pairing still works.
    await repo.create(receipt({ invoiceId: inv }), ctx);
    expect(await paidOf(inv)).toBe(10);
  });

  it("H-02: a party of another tenant (or the wrong kind) is refused", async () => {
    await expect(repo.create(receipt({ partyId: foreignParty }), ctx)).rejects.toThrow();
    await expect(repo.create(receipt({ partyId: supplier }), ctx)).rejects.toThrow();
  });

  it("H-03: SYP invoice @10,000 settled by SYP receipt @20,000 balances in base", async () => {
    const inv = await insertSale({
      partyId: customerA,
      total: 100_000,
      currency: "SYP",
      rate: 10_000,
    });
    const v = await repo.create(
      receipt({ invoiceId: inv, amount: 100_000, currency: "SYP", exchangeRate: 20_000 }),
      ctx,
    );
    const legs = await db
      .select({
        type: ledgerEntries.type,
        bd: ledgerEntries.baseDebit,
        bc: ledgerEntries.baseCredit,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.referenceId, v.id));
    const net = round2dp(legs.reduce((s, l) => s + Number(l.bd ?? 0) - Number(l.bc ?? 0), 0));
    expect(net).toBe(0);
    // Receivable relief $10 vs cash $5 → $5 realized loss.
    expect(legs.find((l) => l.type === "fx_loss")?.bd).toSatisfy((x: unknown) => Number(x) === 5);
    expect(await paidOf(inv)).toBe(100_000);
  });
});
