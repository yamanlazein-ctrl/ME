/**
 * Regressions for the confirmed findings of the forensic audit v2
 * (don't-turs-check-then-chack.md): each test reproduces the exact scenario
 * the audit described and asserts the fail-closed / exact behaviour.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "audit-v2" };
const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const returnRepo = new PostgresReturnRepository(db);
const rows = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;

async function newRoll(kg: number, pieces = 10) {
  const r = await rollRepo.create(
    { colorId, rollNo: `A2-${randomUUID().slice(0, 8)}`, initialKg: kg, remainingKg: kg, pieces, pricePerKg: 4, currency: "USD", supplierId, entryDate: "2026-09-01" },
    ctx,
  );
  return r.id;
}
const rollKg = async (id: string) => Number(rows(await db.execute(sql`select remaining_kg from rolls where id = ${id}::uuid`))[0]!.remaining_kg);
const line = (rollId: string, kg: number, price = 10) => ({ fabricId, colorId, rollId, quantityKg: kg, pieces: 0, pricePerKg: price });
const sell = (lines: ReturnType<typeof line>[]) =>
  invoiceRepo.create({ type: "sale", date: "2026-09-10", partyId: customerId, partyType: "customer", currency: "USD", lines }, ctx);
const saleReturn = (invoiceId: string, rollId: string, kg: number) =>
  returnRepo.create(
    { kind: "sale", date: "2026-09-12", partyId: customerId, originalInvoiceId: invoiceId, reason: "defect", currency: "USD", lines: [{ rollId, quantityKg: kg, pieces: 1, pricePerKg: 10 }] },
    ctx,
  );

describe("audit v2 — confirmed findings", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Audit v2", slug: `a2-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: customerId, tenantId, name: "A2 Customer", code: "A2-C", kind: "customer", currency: "USD" },
      { id: supplierId, tenantId, name: "A2 Supplier", code: "A2-S", kind: "supplier", currency: "USD" },
    ]);
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "A2 Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "A2 White" });
  });

  it("F-001: two lines on one roll cannot together exceed its stock (6 + 6 on 10 kg)", async () => {
    const roll = await newRoll(10);
    await expect(sell([line(roll, 6), line(roll, 6)])).rejects.toThrow(/غير كافٍ/);
    expect(await rollKg(roll)).toBe(10); // nothing written
    await sell([line(roll, 6), line(roll, 4)]); // exactly the stock → allowed
    expect(await rollKg(roll)).toBe(0);
    const mv = rows(await db.execute(sql`select sum(quantity_kg)::float8 q from stock_movements where roll_id = ${roll}::uuid and direction = 'out'`));
    expect(mv[0]!.q).toBe(10); // movement == real stock change
  });

  it("F-002: cancelling a sale return whose goods were sold again is refused, stock untouched", async () => {
    const roll = await newRoll(20);
    const inv = await sell([line(roll, 10)]); // 20 → 10
    const ret = await saleReturn(inv.id, roll, 5); // 10 → 15
    expect(await rollKg(roll)).toBe(15);
    await sell([line(roll, 15)]); // returned kilos sold again → 0
    await expect(returnRepo.cancel(ret.id, ctx.userId, ctx, ret.version)).rejects.toThrow(/لم تعد موجودة/);
    expect(await rollKg(roll)).toBe(0); // never clamped / never a phantom movement
    const phantom = rows(await db.execute(sql`select count(*)::int n from stock_movements where roll_id = ${roll}::uuid and reference_id = ${ret.id}::uuid and direction = 'out'`));
    expect(phantom[0]!.n).toBe(0);
  });

  it("F-002: a sale return can still be cancelled while its goods are in stock", async () => {
    const roll = await newRoll(20);
    const inv = await sell([line(roll, 10)]);
    const ret = await saleReturn(inv.id, roll, 4); // 10 → 14
    await returnRepo.cancel(ret.id, ctx.userId, ctx, ret.version); // 14 → 10
    expect(await rollKg(roll)).toBe(10);
  });

  it("F-003: an invoice with an active return cannot be edited; after cancelling the return it can", async () => {
    const roll = await newRoll(30);
    const inv = await sell([line(roll, 10)]);
    const ret = await saleReturn(inv.id, roll, 2);
    await expect(
      invoiceRepo.update(inv.id, { date: "2026-09-10", lines: [line(roll, 7)] } as never, ctx, inv.version),
    ).rejects.toThrow(/مرتجعات نشطة/);
    await returnRepo.cancel(ret.id, ctx.userId, ctx, ret.version);
    const edited = await invoiceRepo.update(inv.id, { date: "2026-09-10", lines: [line(roll, 7)] } as never, ctx, inv.version);
    expect(edited.version).toBe(inv.version + 1);
  });

  it("F-004: a return is valued at the quantity-WEIGHTED price; a full return restores exactly the invoiced value", async () => {
    const roll = await newRoll(50);
    const inv = await sell([line(roll, 10, 5), line(roll, 1, 9)]); // 50 + 9 = 59.00
    const full = await saleReturn(inv.id, roll, 11);
    const [r] = rows(await db.execute(sql`select price_per_kg::text p, round(quantity_kg * price_per_kg, 2)::float8 v from return_lines where return_id = ${full.id}::uuid`));
    expect(Number(r!.p)).toBeCloseTo(5.3636, 4); // was AVG = 7.00 (→ 77.00)
    expect(r!.v).toBe(59); // exactly what was invoiced
    const posted = rows(await db.execute(sql`select sum(credit)::float8 c from ledger_entries where reference_id = ${full.id}::uuid and party_id = ${customerId}::uuid`));
    expect(posted[0]!.c).toBe(59);
  });

  it("race: two concurrent returns of the same invoice cannot both take the same room", async () => {
    const roll = await newRoll(40);
    const inv = await sell([line(roll, 10)]);
    const results = await Promise.allSettled([saleReturn(inv.id, roll, 6), saleReturn(inv.id, roll, 6)]);
    const ok = results.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(1); // 6 + 6 > 10 sold — only one may pass
    expect(await rollKg(roll)).toBe(36); // 40 − 10 + 6
  });

  it("F-008: financial_operations has row-level security enabled, forced, with a tenant policy", async () => {
    const [t] = rows(await db.execute(sql`select relrowsecurity r, relforcerowsecurity f from pg_class where relname = 'financial_operations'`));
    expect(t).toEqual({ r: true, f: true });
    const pol = rows(await db.execute(sql`select polname, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) w from pg_policy where polrelid = 'financial_operations'::regclass`));
    expect(pol).toHaveLength(1);
    expect(String(pol[0]!.q)).toMatch(/app\.current_tenant_id/);
    expect(String(pol[0]!.w)).toMatch(/app\.current_tenant_id/);
  });
});
