/** Runs against Postgres and, via DB_ENGINE=sqlite's twin resolver, SQLite. */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createInvoiceSchema, updateInvoiceSchema } from "@/presentation/routes/invoice.schema.js";
import {
  createInvoiceUseCase,
  updateInvoiceUseCase,
} from "@/application/use-cases/invoices/invoiceUseCases.js";
import type { IAuditRepository } from "@/application/ports/IAuditRepository.js";
import type { TenantContext } from "@/domain/types/index.js";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresLedgerRepository } from "@/infrastructure/repositories/PostgresLedgerRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const supplierId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "invoice-weight-regression",
};
const date = "2026-02-01";
const line = {
  fabricId,
  colorId,
  rollId: randomUUID(),
  quantityKg: 10,
  pieces: 1,
  pricePerKg: 4.75,
  discountAmount: 0.5,
};
const adjustments = { discount: 1, tax: 0.25, shipping: 0.5 };

const audit: IAuditRepository = {
  create: vi.fn<IAuditRepository["create"]>().mockResolvedValue(undefined),
  list: vi.fn<IAuditRepository["list"]>(),
};

function editBody(quantityKg: unknown) {
  return { date, lines: [{ ...line, quantityKg }], ...adjustments };
}

describe("invoice weight validation", () => {
  it("coerces quantityKg and strips stale client-derived totals on create and update", () => {
    const body = {
      ...editBody("12.5"),
      subtotal: 47,
      total: 46.75,
      amountDue: 41.75,
      baseTotal: 46.75,
    };
    const created = createInvoiceSchema.parse({
      ...body,
      type: "entry",
      partyId: supplierId,
      partyType: "supplier",
      currency: "USD",
    });
    const updated = updateInvoiceSchema.parse(body);
    for (const parsed of [created, updated]) {
      expect(parsed.lines[0].quantityKg).toBe(12.5);
      for (const field of ["subtotal", "total", "amountDue", "baseTotal"]) {
        expect(parsed).not.toHaveProperty(field);
      }
    }
  });

  it.each([0, -1, 1.001, 100000.01, "not-a-weight"])(
    "rejects invalid quantityKg %s on both create and update",
    (quantityKg) => {
      const body = editBody(quantityKg);
      expect(updateInvoiceSchema.safeParse(body).success).toBe(false);
      expect(
        createInvoiceSchema.safeParse({
          ...body,
          type: "sale",
          partyId: supplierId,
          partyType: "customer",
        }).success,
      ).toBe(false);
    },
  );
});

describe("quantity-only invoice edits persist recalculated financials", () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await db.insert(tenants).values({
      id: tenantId,
      name: "Invoice weight regression",
      slug: `weight-${tenantId}`,
    });
    await db.insert(parties).values({
      id: supplierId,
      tenantId,
      name: "Weight supplier",
      kind: "supplier",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Weight fabric" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "Weight color" });
  });

  it.for(["entry", "sale"] as const)(
    "%s: increasing then decreasing only quantity updates totals, due, stock and ledger",
    async (type, test) => {
      skipUnlessDatabase(reachable, test.skip);
      const isSale = type === "sale";
      const partyType = isSale ? "customer" : "supplier";
      // Each case owns its party, so balance/list assertions cannot include the other invoice.
      const partyId = randomUUID();
      await db.insert(parties).values({
        id: partyId,
        tenantId,
        name: `Invoice weight ${partyType}`,
        kind: partyType,
        currency: "USD",
      });
      const rollRepo = new PostgresRollRepository(db);
      const repo = new PostgresInvoiceRepository(db);
      const ledgerRepo = new PostgresLedgerRepository(db);
      const partyRepo = new PostgresPartyRepository(db);
      const roll = await rollRepo.create(
        {
          colorId,
          supplierId,
          rollNo: `W-${randomUUID()}`,
          initialKg: 100,
          remainingKg: isSale ? 100 : 0,
          pieces: 4,
          pricePerKg: 2,
          currency: "USD",
          entryDate: date,
        },
        ctx,
      );
      const input = createInvoiceSchema.parse({
        type,
        date,
        partyId,
        partyType,
        currency: "USD",
        exchangeRate: 1,
        paid: 5,
        paymentMethod: "transfer",
        ...adjustments,
        lines: [{ ...line, rollId: roll.id }],
      });
      const created = await createInvoiceUseCase(repo, audit, input, ctx);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      let current = created.data;
      expect(current).toMatchObject({ subtotal: 47, total: 46.75, paid: 5, amountDue: 41.75 });
      expect(current.linkedVoucherId).toBeTruthy();
      const invoiceLegs = () =>
        db
          .select()
          .from(ledgerEntries)
          .where(
            and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.referenceId, current.id)),
          );
      const paymentLegs = () =>
        db
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, tenantId),
              eq(ledgerEntries.referenceId, created.data.linkedVoucherId!),
            ),
          );
      const originalPaymentLegs = await paymentLegs();
      expect(originalPaymentLegs).toHaveLength(2);

      // Expected amounts are literals, not the implementation's calculator: 12.5 * 4.75 - 0.5
      // rounds half away from zero to 58.88, then header adjustments give 58.63.
      for (const expected of [
        { quantityKg: 12.5, subtotal: 58.88, total: 58.63, due: 53.63, cogs: 25 },
        { quantityKg: 7.25, subtotal: 33.94, total: 33.69, due: 28.69, cogs: 14.5 },
      ]) {
        const beforeLegs = await invoiceLegs();
        const oldActive = beforeLegs.filter((l) => l.status === "active");
        const update = updateInvoiceSchema.parse({
          date: input.date,
          ...adjustments,
          lines: [{ ...input.lines[0], quantityKg: String(expected.quantityKg) }],
          // These stale previews must never override the server's quantity-based calculation.
          subtotal: current.subtotal,
          total: current.total,
          amountDue: current.amountDue,
        });
        const result = await updateInvoiceUseCase(
          repo,
          audit,
          current.id,
          update,
          ctx,
          current.version,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        const expectedHeader = {
          subtotal: expected.subtotal,
          total: expected.total,
          baseTotal: expected.total,
          paid: 5,
          amountDue: expect.closeTo(expected.due, 8),
          exchangeRate: 1,
          piecesCount: 1,
          version: current.version + 1,
          ...adjustments,
        };
        expect(result.data).toMatchObject(expectedHeader);
        current = result.data;
        const reloaded = await repo.findById(current.id, ctx);
        expect(reloaded).toMatchObject(expectedHeader);
        expect(reloaded?.lines).toHaveLength(1);
        expect(reloaded?.lines[0]).toMatchObject({
          ...input.lines[0],
          quantityKg: expected.quantityKg,
        });
        const [stored] = await db.select().from(invoices).where(eq(invoices.id, current.id));
        expect(stored).toMatchObject({
          subtotal: expected.subtotal,
          total: expected.total,
          baseTotal: expected.total,
          paid: 5,
          version: current.version,
        });
        const storedLines = await db
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, current.id));
        expect(storedLines).toHaveLength(1);
        expect(Number(storedLines[0].quantityKg)).toBe(expected.quantityKg);
        expect((await rollRepo.findById(roll.id, ctx))?.remainingKg).toBe(
          isSale ? 100 - expected.quantityKg : expected.quantityKg,
        );

        const allLegs = await invoiceLegs();
        // Prior financial legs survive unchanged, but no longer contribute to balances.
        for (const old of oldActive) {
          expect(allLegs.find((l) => l.id === old.id)).toMatchObject({
            ...old,
            status: "cancelled",
            cancelledBy: ctx.userId,
            cancelledAt: expect.any(Date),
          });
        }
        const active = allLegs.filter((l) => l.status === "active");
        expect(active).toHaveLength(isSale ? 4 : 2);
        expect(active.find((l) => l.partyId === partyId)).toMatchObject({
          type: isSale ? "sales_invoice" : "purchase_invoice",
          debit: isSale ? expected.total : 0,
          credit: isSale ? 0 : expected.total,
          baseDebit: isSale ? expected.total : 0,
          baseCredit: isSale ? 0 : expected.total,
        });
        expect(
          active.find((l) => l.type === (isSale ? "sales_revenue" : "inventory_asset")),
        ).toMatchObject({
          debit: isSale ? 0 : expected.total,
          credit: isSale ? expected.total : 0,
        });
        if (isSale) {
          expect(active.find((l) => l.type === "cogs_expense")?.debit).toBe(expected.cogs);
          expect(active.find((l) => l.type === "inventory_asset")?.credit).toBe(expected.cogs);
        }
        expect(active.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)).toBeCloseTo(
          0,
          8,
        );
        expect(
          active.reduce((sum, l) => sum + Number(l.baseDebit) - Number(l.baseCredit), 0),
        ).toBeCloseTo(0, 8);
        expect(await paymentLegs()).toEqual(originalPaymentLegs);
        expect((await ledgerRepo.getBalance(partyId, ctx, "USD")).balance).toBeCloseTo(
          expected.due,
          8,
        );
        const listed = await partyRepo.list({ kind: partyType, limit: 100 }, ctx);
        expect(listed.data.find((p) => p.id === partyId)?.stats).toMatchObject({
          invoicesCount: 1,
          totalAmount: expected.total,
          totalPaid: 5,
          remaining: expect.closeTo(expected.due, 8),
        });
      }
    },
  );

  it.for(["entry", "sale"] as const)(
    "%s: multi-line quantity edits reload independently and reach the party statement",
    async (type, test) => {
      skipUnlessDatabase(reachable, test.skip);
      const isSale = type === "sale";
      const partyType = isSale ? "customer" : "supplier";
      const partyId = randomUUID();
      await db.insert(parties).values({
        id: partyId,
        tenantId,
        name: `Multi-line weight ${partyType}`,
        kind: partyType,
        currency: "USD",
      });
      const rollRepo = new PostgresRollRepository(db);
      const repo = new PostgresInvoiceRepository(db);
      const ledgerRepo = new PostgresLedgerRepository(db);
      const partyRepo = new PostgresPartyRepository(db);
      const statementRepo = new PostgresStatementRepository(db);
      const fixtureLines = [];
      for (const [index, amounts] of [
        { quantityKg: 10, pricePerKg: 4.75, discountAmount: 0.5, pieces: 1, cost: 2 },
        { quantityKg: 8, pricePerKg: 3.25, discountAmount: 0.25, pieces: 2, cost: 1.5 },
        { quantityKg: 4, pricePerKg: 2.5, discountAmount: 0, pieces: 1, cost: 1 },
      ].entries()) {
        const distinctColorId = randomUUID();
        const colorName = `Multi-line ${type} color ${index}`;
        await db
          .insert(colors)
          .values({ id: distinctColorId, tenantId, fabricId, name: colorName });
        const roll = await rollRepo.create(
          {
            colorId: distinctColorId,
            supplierId,
            rollNo: `WM-${randomUUID()}`,
            initialKg: 100,
            remainingKg: isSale ? 100 : 0,
            pieces: 4,
            pricePerKg: amounts.cost,
            currency: "USD",
            entryDate: date,
          },
          ctx,
        );
        fixtureLines.push({
          fabricId,
          colorId: distinctColorId,
          rollId: roll.id,
          quantityKg: amounts.quantityKg,
          pricePerKg: amounts.pricePerKg,
          discountAmount: amounts.discountAmount,
          pieces: amounts.pieces,
          note: `Unchanged ${type} line ${index}`,
        });
      }
      expect(new Set(fixtureLines.map((l) => l.colorId)).size).toBe(3);
      expect(new Set(fixtureLines.map((l) => l.rollId)).size).toBe(3);
      const input = createInvoiceSchema.parse({
        type,
        date,
        partyId,
        partyType,
        currency: "USD",
        exchangeRate: 1,
        paid: 5,
        paymentMethod: "transfer",
        ...adjustments,
        lines: fixtureLines,
      });
      const created = await createInvoiceUseCase(repo, audit, input, ctx);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);
      let current = created.data;
      expect(current).toMatchObject({ subtotal: 82.75, total: 82.5, amountDue: 77.5 });

      // The third line stays unchanged. The first two move in opposite directions on each edit.
      // Statement line amounts are gross quantity * price; its document/ledger amount is net.
      for (const expected of [
        {
          quantities: [12.5, 6.25, 4],
          subtotal: 88.94,
          total: 88.69,
          due: 83.69,
          quantityKg: 22.75,
          lineAmounts: [59.38, 20.31, 10],
          cogs: 38.38,
        },
        {
          quantities: [7.25, 9.5, 4],
          subtotal: 74.57,
          total: 74.32,
          due: 69.32,
          quantityKg: 20.75,
          lineAmounts: [34.44, 30.88, 10],
          cogs: 32.75,
        },
      ]) {
        const updatedLines = input.lines.map((l, index) => ({
          ...l,
          quantityKg: expected.quantities[index],
        }));
        const result = await updateInvoiceUseCase(
          repo,
          audit,
          current.id,
          updateInvoiceSchema.parse({ date, ...adjustments, lines: updatedLines }),
          ctx,
          current.version,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        const header = {
          date,
          partyId,
          partyType,
          currency: "USD",
          exchangeRate: 1,
          subtotal: expected.subtotal,
          total: expected.total,
          baseTotal: expected.total,
          paid: 5,
          piecesCount: 4,
          version: current.version + 1,
          ...adjustments,
        };
        expect(result.data).toMatchObject({
          ...header,
          amountDue: expect.closeTo(expected.due, 8),
        });
        current = result.data;
        const reloaded = await repo.findById(current.id, ctx);
        expect(reloaded).toMatchObject({ ...header, amountDue: expect.closeTo(expected.due, 8) });
        const [stored] = await db.select().from(invoices).where(eq(invoices.id, current.id));
        expect(stored).toMatchObject(header);
        const storedLines = await db
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, current.id));
        expect(reloaded?.lines).toHaveLength(3);
        expect(storedLines).toHaveLength(3);
        for (const l of updatedLines) {
          expect(reloaded?.lines.find((r) => r.rollId === l.rollId)).toMatchObject(l);
          const storedLine = storedLines.find((r) => r.rollId === l.rollId)!;
          expect(storedLine).toMatchObject({
            fabricId: l.fabricId,
            colorId: l.colorId,
            rollId: l.rollId,
            pieces: l.pieces,
            note: l.note,
          });
          expect(Number(storedLine.quantityKg)).toBe(l.quantityKg);
          expect(Number(storedLine.pricePerKg)).toBe(l.pricePerKg);
          expect(Number(storedLine.discountAmount)).toBe(l.discountAmount);
          expect((await rollRepo.findById(l.rollId, ctx))?.remainingKg).toBe(
            isSale ? 100 - l.quantityKg : l.quantityKg,
          );
        }

        const active = await db
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, tenantId),
              eq(ledgerEntries.referenceId, current.id),
              eq(ledgerEntries.status, "active"),
            ),
          );
        expect(active).toHaveLength(isSale ? 4 : 2);
        expect(active.find((l) => l.partyId === partyId)).toMatchObject({
          type: isSale ? "sales_invoice" : "purchase_invoice",
          debit: isSale ? expected.total : 0,
          credit: isSale ? 0 : expected.total,
          baseDebit: isSale ? expected.total : 0,
          baseCredit: isSale ? 0 : expected.total,
        });
        expect(
          active.find((l) => l.type === (isSale ? "sales_revenue" : "inventory_asset")),
        ).toMatchObject({
          debit: isSale ? 0 : expected.total,
          credit: isSale ? expected.total : 0,
        });
        if (isSale) {
          expect(active.find((l) => l.type === "cogs_expense")?.debit).toBe(expected.cogs);
          expect(active.find((l) => l.type === "inventory_asset")?.credit).toBe(expected.cogs);
        }
        expect(active.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0)).toBeCloseTo(
          0,
          8,
        );
        expect(
          active.reduce((sum, l) => sum + Number(l.baseDebit) - Number(l.baseCredit), 0),
        ).toBeCloseTo(0, 8);
        expect((await ledgerRepo.getBalance(partyId, ctx, "USD")).balance).toBeCloseTo(
          expected.due,
          8,
        );
        const listed = await partyRepo.list({ kind: partyType, limit: 100 }, ctx);
        expect(listed.data.find((p) => p.id === partyId)?.stats).toMatchObject({
          invoicesCount: 1,
          totalAmount: expected.total,
          totalPaid: 5,
          remaining: expect.closeTo(expected.due, 8),
        });

        const statement = await statementRepo.getStatement(
          { partyId, kind: partyType, currency: "USD" },
          ctx,
        );
        expect(statement).toMatchObject({
          previousBalance: 0,
          totalDebit: isSale ? expected.total : 5,
          totalCredit: isSale ? 5 : expected.total,
          finalBalance: expected.due,
        });
        expect(statement.totalsByCurrency?.USD.finalBalance).toBe(expected.due);
        const statementInvoices = statement.entries.filter(
          (e) => e.referenceId === current.id && e.status === "active",
        );
        expect(statementInvoices).toHaveLength(1);
        const statementInvoice = statementInvoices[0];
        expect(statementInvoice).toMatchObject({
          quantityKg: expected.quantityKg,
          debit: isSale ? expected.total : 0,
          credit: isSale ? 0 : expected.total,
          document: {
            kind: "invoice",
            number: current.number,
            currency: "USD",
            amount: expected.total,
            paid: 5,
          },
        });
        expect(statementInvoice.lines).toHaveLength(3);
        for (const [index, l] of updatedLines.entries()) {
          expect(statementInvoice.lines?.find((r) => r.rollId === l.rollId)).toMatchObject({
            fabricId: l.fabricId,
            colorId: l.colorId,
            rollId: l.rollId,
            quantityKg: l.quantityKg,
            pricePerKg: l.pricePerKg,
            amount: expected.lineAmounts[index],
          });
        }
      }
    },
  );
});
