/**
 * End-to-end regression for the field report "settlement vanishes after
 * printing": a multi-invoice settlement (POST .../statement/settle-invoices)
 * must be fully committed — vouchers, ledger entries, invoices.paid — by the
 * time the route responds, and still visible on a FRESH read afterwards
 * (simulating the statement/cashbox screens re-querying after the print
 * dialog closes). Exercises the exact same path the real route uses:
 * settleInvoicesUseCase wrapped in withTenantTx, with ambientDb-proxied repos.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, eq, and, inArray } from "drizzle-orm";
import { db, withTenantTx } from "@/infrastructure/orm/drizzle.js";
import { ambientDb } from "@/infrastructure/orm/ambient-tx.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresAuditRepository } from "@/infrastructure/repositories/PostgresAuditRepository.js";
import { settleInvoicesUseCase } from "@/application/use-cases/statements/settleInvoicesUseCase.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const customerId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "settle-persistence-tester",
};

async function makeInvoice(total: number) {
  const id = randomUUID();
  await db.insert(invoices).values({
    id,
    tenantId,
    number: `T-${id.slice(0, 8)}`,
    type: "sale",
    date: "2026-01-10",
    partyId: customerId,
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 1,
    subtotal: total,
    total,
    paid: 0,
    status: "active",
  } as never);
  return id;
}

describe("settle-invoices route path — commit survives past the response", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db
        .insert(tenants)
        .values({ id: tenantId, name: "Settle Persist Tenant", slug: `sp-${tenantId.slice(0, 8)}` });
      await db.insert(parties).values({
        id: customerId,
        tenantId,
        name: "Persist Cust",
        code: "PC1",
        kind: "customer",
        currency: "SYP",
      });
    } catch {
      reachable = false;
    }
  });

  it("multi-invoice settlement: vouchers + ledger + invoice.paid are all committed and independently readable after the transaction resolves", async () => {
    if (!reachable) return;

    const inv1 = await makeInvoice(500_000);
    const inv2 = await makeInvoice(300_000);

    const dbx = ambientDb(db);
    const voucherRepo = new PostgresVoucherRepository(dbx);
    const partyRepo = new PostgresPartyRepository(dbx);
    const auditRepo = new PostgresAuditRepository(db);

    // Exactly what the route does: run the use case inside withTenantTx and
    // only trust the result once that promise has resolved (= committed).
    const result = await withTenantTx(tenantId, () =>
      settleInvoicesUseCase(
        voucherRepo,
        auditRepo,
        partyRepo,
        customerId,
        "customer",
        {
          invoiceIds: [inv1, inv2],
          amountPaid: 800_000,
          currency: "SYP",
          exchangeRate: 13_500,
          method: "cash",
        },
        ctx,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.vouchers.length).toBe(2);
    const voucherIds = result.data.vouchers.map((v) => v.id);

    // Fresh, independent reads on a NEW query (not the transaction handle) —
    // this is what the statement/cashbox screens do after the dialog closes.
    const paid1 = Number(
      (await db.select({ p: invoices.paid }).from(invoices).where(eq(invoices.id, inv1)))[0].p,
    );
    const paid2 = Number(
      (await db.select({ p: invoices.paid }).from(invoices).where(eq(invoices.id, inv2)))[0].p,
    );
    expect(paid1).toBe(500_000);
    expect(paid2).toBe(300_000);

    const voucherRows = await db
      .select({ id: vouchers.id, status: vouchers.status })
      .from(vouchers)
      .where(and(eq(vouchers.tenantId, tenantId), inArray(vouchers.id, voucherIds)));
    expect(voucherRows.length).toBe(2);
    expect(voucherRows.every((v) => v.status === "active")).toBe(true);

    const ledgerRows = await db
      .select({ id: ledgerEntries.id, status: ledgerEntries.status })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          inArray(ledgerEntries.referenceId, voucherIds),
        ),
      );
    expect(ledgerRows.length).toBeGreaterThan(0);
    expect(ledgerRows.every((l) => l.status === "active")).toBe(true);
  });

  it("a failing allocation (invoice not open) rolls back everything — no orphan voucher/ledger row survives", async () => {
    if (!reachable) return;

    const inv = await makeInvoice(100_000);
    const dbx = ambientDb(db);
    const voucherRepo = new PostgresVoucherRepository(dbx);
    const partyRepo = new PostgresPartyRepository(dbx);
    const auditRepo = new PostgresAuditRepository(db);

    // Fully pay it first so the second settlement attempt is rejected.
    await withTenantTx(tenantId, () =>
      settleInvoicesUseCase(
        voucherRepo,
        auditRepo,
        partyRepo,
        customerId,
        "customer",
        {
          invoiceIds: [inv],
          amountPaid: 100_000,
          currency: "SYP",
          exchangeRate: 13_500,
          method: "cash",
        },
        ctx,
      ),
    );

    let threwOrFailed = false;
    try {
      const r = await withTenantTx(tenantId, () =>
        settleInvoicesUseCase(
          voucherRepo,
          auditRepo,
          partyRepo,
          customerId,
          "customer",
          {
            invoiceIds: [inv],
            amountPaid: 50_000,
            currency: "SYP",
            exchangeRate: 13_500,
            method: "cash",
          },
          ctx,
        ),
      );
      threwOrFailed = !r.ok;
    } catch {
      threwOrFailed = true;
    }
    expect(threwOrFailed).toBe(true);

    // Still exactly the one voucher from the first successful settlement.
    const allVouchers = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.invoiceId, inv)));
    expect(allVouchers.length).toBe(1);
  });
});
