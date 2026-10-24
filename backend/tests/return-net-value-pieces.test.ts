/**
 * CODEBASE_AUDIT_REPORT H-04 / H-05 — sale returns. Engine-agnostic (SQLite + PG).
 *  H-04: a full return of a line sold with a line discount credits the NET line value, not q × price.
 *  H-05: returned pieces are bounded by the pieces sold less earlier returns; a remnant (0-piece)
 *        sale returns weight only.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "ret-net-tester",
};
const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const returnRepo = new PostgresReturnRepository(db);

const newRoll = async (kg: number, pieces: number) =>
  (
    await rollRepo.create(
      {
        colorId,
        rollNo: `R-${randomUUID().slice(0, 8)}`,
        initialKg: kg,
        remainingKg: kg,
        pieces,
        pricePerKg: 4,
        currency: "USD",
        entryDate: "2026-09-01",
      },
      ctx,
    )
  ).id;

const sell = (rollId: string, kg: number, pieces: number, discountAmount = 0) =>
  invoiceRepo.create(
    {
      type: "sale",
      date: "2026-09-10",
      partyId: customerId,
      partyType: "customer",
      currency: "USD",
      lines: [
        { fabricId, colorId, rollId, quantityKg: kg, pieces, pricePerKg: 10, discountAmount },
      ],
    } as never,
    ctx,
  );

const ret = (invoiceId: string, rollId: string, kg: number, pieces: number) =>
  returnRepo.create(
    {
      kind: "sale",
      date: "2026-09-12",
      partyId: customerId,
      originalInvoiceId: invoiceId,
      reason: "defect",
      currency: "USD",
      lines: [{ rollId, quantityKg: kg, pieces, pricePerKg: 10 }],
    },
    ctx,
  );

const rollState = async (id: string) => {
  const [r] = await db
    .select({ kg: rolls.remainingKg, pieces: rolls.remainingPieces })
    .from(rolls)
    .where(eq(rolls.id, id));
  return { kg: Number(r!.kg), pieces: Number(r!.pieces) };
};

describe("sale returns: net value and piece conservation", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Ret Net", slug: `rnet-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "C",
      code: "RNET-C",
      kind: "customer",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
  });

  it("H-05 + H-04: 500 pieces are refused; the full return credits the discounted $80", async () => {
    const rollId = await newRoll(20, 2);
    const inv = await sell(rollId, 10, 1, 20); // 10 kg × $10 − $20 line discount = $80
    expect(Number(inv.total)).toBe(80);

    await expect(ret(inv.id, rollId, 10, 500)).rejects.toThrow();
    expect(await rollState(rollId)).toEqual({ kg: 10, pieces: 1 });

    const r = await ret(inv.id, rollId, 10, 1);
    const [partyLeg] = await db
      .select({ credit: ledgerEntries.credit })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.referenceId, r.id), isNotNull(ledgerEntries.partyId)));
    expect(Number(partyLeg!.credit)).toBe(80);
    expect(await rollState(rollId)).toEqual({ kg: 20, pieces: 2 });
  });

  it("H-05: a remnant sold with 0 pieces is returned by weight only", async () => {
    const rollId = await newRoll(20, 2);
    const inv = await sell(rollId, 3, 0);
    await ret(inv.id, rollId, 3, 1);
    expect(await rollState(rollId)).toEqual({ kg: 20, pieces: 2 });
  });

  it("a roll entered without a piece count is returned to the supplier by weight only", async () => {
    // The entry screen leaves the piece count unset (0). A return to the supplier used to demand a
    // whole piece the roll never had, and the whole return was refused.
    const supplierId = randomUUID();
    await db.insert(parties).values({
      id: supplierId,
      tenantId,
      name: "S",
      code: "RNET-S",
      kind: "supplier",
      currency: "USD",
    });
    const rollId = (
      await rollRepo.create(
        {
          colorId,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 30,
          remainingKg: 0,
          pieces: 0,
          pricePerKg: 4,
          currency: "USD",
          entryDate: "2026-09-01",
        },
        ctx,
      )
    ).id;
    const entry = await invoiceRepo.create(
      {
        type: "entry",
        date: "2026-09-05",
        partyId: supplierId,
        partyType: "supplier",
        currency: "USD",
        lines: [{ fabricId, colorId, rollId, quantityKg: 30, pieces: 0, pricePerKg: 4 }],
      } as never,
      ctx,
    );
    expect(await rollState(rollId)).toEqual({ kg: 30, pieces: 0 });

    await returnRepo.create(
      {
        kind: "entry",
        date: "2026-09-06",
        partyId: supplierId,
        originalInvoiceId: entry.id,
        reason: "defect",
        currency: "USD",
        lines: [{ rollId, quantityKg: 10, pieces: 1, pricePerKg: 4 }],
      },
      ctx,
    );
    expect(await rollState(rollId)).toEqual({ kg: 20, pieces: 0 });
  });
});
