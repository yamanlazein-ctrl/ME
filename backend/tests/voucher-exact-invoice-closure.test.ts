/**
 * A payment that fully covers an invoice must leave the balance at EXACTLY 0,
 * whatever the currencies/rates, and cancelling it must restore the exact
 * previous balance (no USD→SYP→USD rounding residue either way).
 *
 * Regression for: 1,000,000 SYP invoice paid with 74.07 USD @ 13,500 used to leave
 * 55 SYP forever (and 74.08 USD was rejected as over-payment).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { BusinessRuleError } from "@/domain/errors/index.js";
import type { TenantContext } from "@/domain/types/index.js";
import { eq } from "drizzle-orm";

let reachable = false;
const tenantId = randomUUID();
const customerId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "closure-tester",
};

async function makeInvoice(total: number, currency: "SYP" | "USD", rate: number) {
  const id = randomUUID();
  await db.insert(invoices).values({
    id,
    tenantId,
    number: `T-${id.slice(0, 8)}`,
    type: "sale",
    date: "2026-01-10",
    partyId: customerId,
    partyType: "customer",
    currency,
    exchangeRate: rate,
    subtotal: total,
    total,
    paid: 0,
    status: "active",
  } as never);
  return id;
}
const paidOf = async (id: string) =>
  Number((await db.select({ p: invoices.paid }).from(invoices).where(eq(invoices.id, id)))[0].p);

const receipt = (
  repo: PostgresVoucherRepository,
  invoiceId: string,
  amount: number,
  currency: "SYP" | "USD",
  rate?: number,
) =>
  repo.create(
    {
      kind: "receipt",
      date: "2026-01-10",
      partyId: customerId,
      partyKind: "customer",
      invoiceId,
      amount,
      currency,
      exchangeRate: rate,
      method: "transfer",
    } as never,
    ctx,
  );

describe("exact invoice closure on payment", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db
        .insert(tenants)
        .values({ id: tenantId, name: "Closure Tenant", slug: `clo-${tenantId.slice(0, 8)}` });
      await db
        .insert(parties)
        .values({
          id: customerId,
          tenantId,
          name: "Cust",
          code: "C1",
          kind: "customer",
          currency: "SYP",
        });
    } catch {
      reachable = false;
    }
  });

  it("cent-rounded USD payment closes an uneven SYP invoice to exactly 0; cancel restores exactly", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const inv = await makeInvoice(1_000_000, "SYP", 13_500);
    const v = await receipt(repo, inv, 74.07, "USD", 13_500);
    expect(await paidOf(inv)).toBe(1_000_000);
    await repo.cancel(v.id, ctx.userId, ctx, v.version ?? 1);
    expect(await paidOf(inv)).toBe(0);
  });

  it("partials then a final payment at a different rate leave exactly 0", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const inv = await makeInvoice(1_000_000, "SYP", 13_500);
    await receipt(repo, inv, 30, "USD", 13_500); // 405,000
    expect(await paidOf(inv)).toBe(405_000);
    await receipt(repo, inv, 43.43, "USD", 13_700); // remaining 595,000 / 13,700 = 43.43…
    expect(await paidOf(inv)).toBe(1_000_000);
  });

  it("a real over-payment (one full cent too many) closes the invoice and keeps the excess as credit", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const inv = await makeInvoice(1_000_000, "SYP", 13_500);
    // 74.08 USD × 13,500 = 1,000,080 SYP → invoice closes at exactly its total,
    // the 80 SYP excess is customer credit (not a rejection any more).
    const v = await receipt(repo, inv, 74.08, "USD", 13_500);
    expect(await paidOf(inv)).toBe(1_000_000);
    expect(v.appliedAmount).toBe(1_000_000);
  });

  it("SYP payment closes a USD invoice exactly", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const inv = await makeInvoice(74.07, "USD", 1);
    await receipt(repo, inv, 1_000_000, "SYP", 13_500);
    expect(await paidOf(inv)).toBe(74.07);
  });
});
