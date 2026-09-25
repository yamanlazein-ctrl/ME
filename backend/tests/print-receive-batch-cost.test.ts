/**
 * Receiving from the press: the lost weight is absorbed by the sellable
 * fabric (approved 2026-09-25).
 *   batch cost = raw cost of everything sent + press charges
 *   unit cost  = batch cost / net kilos received   (stored at 4 decimals)
 * Before: unit cost = raw price + print price per kilo, so the value of the
 * lost kilos silently vanished and profit on printed fabric was overstated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { PostgresPrintJobRepository } from "@/infrastructure/repositories/PostgresPrintJobRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "press" };
const rows = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;

async function rawRoll(price: number, kg: number) {
  const fabricId = randomUUID(), colorId = randomUUID(), id = randomUUID();
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: `قطن ${id.slice(0, 6)}` });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "خام" });
  await db.insert(rolls).values({
    id, tenantId, colorId, rollNo: `RAW-${id.slice(0, 6)}`, initialKg: String(kg), remainingKg: String(kg),
    pieces: 4, remainingPieces: 4, pricePerKg: String(price), currency: "USD", entryDate: "2026-09-01",
  } as never);
  return id;
}

async function cycle(price: number, sentKg: number, netKg: number, printCostPerKg: number) {
  const repo = new PostgresPrintJobRepository(db);
  const src = await rawRoll(price, 100);
  const job = await repo.create({ date: "2026-09-10", sourceRollId: src, quantityKg: sentKg, pieces: 2, pressName: "مطبعة النور", printCostPerKg, currency: "USD" } as never, null, ctx);
  const done = await repo.receive({ jobId: job.id, date: "2026-09-14", receivedKg: netKg, printCostPerKg, currency: "USD" } as never, ctx);
  const [out] = rows(await db.execute(sql`select price_per_kg::text p, remaining_kg::float8 kg from rolls where id = ${done.resultRollId!}::uuid`));
  const [srcRow] = rows(await db.execute(sql`select remaining_kg::float8 kg from rolls where id = ${src}::uuid`));
  const cashOut = rows(await db.execute(sql`select credit::float8 c from ledger_entries where reference_id = ${job.id}::uuid and type = 'cash'`));
  return { unit: Number(out!.p), unitText: String(out!.p), kg: Number(out!.kg), srcKg: Number(srcRow!.kg), cash: Number(cashOut[0]?.c ?? 0) };
}

describe("press receive — waste absorbed into the net kilos", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Press", slug: `pr-${tenantId.slice(0, 8)}` });
  });

  it("60 kg sent at 3.80, 57 kg received, print 0.60 → 4.60/kg (was 4.40)", async () => {
    const r = await cycle(3.8, 60, 57, 0.6);
    // (60 × 3.80 + 57 × 0.60) / 57 = (228 + 34.20) / 57 = 4.60
    expect(r.unit).toBeCloseTo(4.6, 4);
    expect(r.kg).toBe(57);
    expect(r.srcKg).toBe(40); // the whole 60 kg left the raw roll
    expect(r.cash).toBeCloseTo(34.2, 2); // press paid for the net kilos
    // stock value of the printed roll == full batch cost (nothing vanished)
    expect(r.kg * r.unit).toBeCloseTo(228 + 34.2, 2);
  });

  it("an inexact batch stays within a fraction of a cent of its real cost (4-decimal cost)", async () => {
    const r = await cycle(3.85, 61, 58, 0.6);
    const batch = 61 * 3.85 + 58 * 0.6; // 269.65
    expect(r.unitText).toMatch(/^\d+\.\d{4}$/);
    expect(Math.abs(r.kg * r.unit - batch)).toBeLessThan(0.005);
  });

  it("no waste → unit cost is simply raw + print", async () => {
    const r = await cycle(4, 20, 20, 0.5);
    expect(r.unit).toBeCloseTo(4.5, 4);
  });

  it("cost columns carry 4 decimals", async () => {
    const cols = rows(await db.execute(sql`
      select table_name t, column_name c, numeric_scale s from information_schema.columns
       where (table_name, column_name) in (('rolls','price_per_kg'), ('invoice_lines','cost_per_kg')) order by 1`));
    expect(cols.map((x) => `${x.t}.${x.c}:${x.s}`)).toEqual(["invoice_lines.cost_per_kg:4", "rolls.price_per_kg:4"]);
  });
});
