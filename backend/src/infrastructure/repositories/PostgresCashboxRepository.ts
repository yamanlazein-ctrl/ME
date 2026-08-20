import { eq, and, desc, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { ICashboxRepository } from "../../application/ports/ICashboxRepository.js";
import { cashboxSessions, manualMovements, dayCloses } from "../orm/schemas/cashbox.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import type {
  CashboxState,
  DayCloseData,
  ManualMovementData,
  CreateManualMovementInput,
  CloseDayRequestInput,
} from "../../domain/entities/Cashbox.js";
import { CashboxSession, ManualMovement, DayClose } from "../../domain/entities/Cashbox.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";

export class PostgresCashboxRepository implements ICashboxRepository {
  constructor(private readonly db: DB) {}

  async getState(ctx: TenantContext): Promise<CashboxState> {
    const [session] = await this.db
      .select()
      .from(cashboxSessions)
      .where(eq(cashboxSessions.tenantId, ctx.tenantId))
      .limit(1);
    const [closing] = await this.db
      .select()
      .from(dayCloses)
      .where(eq(dayCloses.tenantId, ctx.tenantId))
      .orderBy(desc(dayCloses.closedAt))
      .limit(1);
    const today = new Date().toISOString().slice(0, 10);
    const [lock] = await this.db
      .select()
      .from(dayCloses)
      .where(and(eq(dayCloses.tenantId, ctx.tenantId), eq(dayCloses.date, today)))
      .limit(1);
    return {
      session: session ? this.toSessionData(session) : null,
      isLocked: !!lock,
      lastClosing: closing ? this.toDayCloseDomain(closing) : null,
    };
  }

  private toSessionData(row: typeof cashboxSessions.$inferSelect) {
    return CashboxSession.reconstitute({
      id: row.id,
      tenantId: row.tenantId,
      openingBalance: row.openingBalance,
      openingDate: row.openingDate,
      currency: row.currency,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }).toData();
  }

  async setOpeningBalance(
    amount: number,
    date: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(cashboxSessions)
      .where(eq(cashboxSessions.tenantId, ctx.tenantId))
      .limit(1);
    if (existing) {
      await this.db
        .update(cashboxSessions)
        .set({ openingBalance: amount, openingDate: date, currency, updatedAt: new Date() })
        .where(eq(cashboxSessions.id, existing.id));
    } else {
      await this.db
        .insert(cashboxSessions)
        .values({ tenantId: ctx.tenantId, openingBalance: amount, openingDate: date, currency });
    }
  }

  async addManualMovement(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<ManualMovementData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(manualMovements)
        .values({
          tenantId: ctx.tenantId,
          date: input.date,
          type: input.type,
          direction: input.direction,
          amount: input.amount,
          currency: input.currency ?? "SYP",
          description: input.description,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
        })
        .returning();
      // Accounting traceability: reflect the manual cashbox movement in the
      // general ledger. cashImpact stays "none" so the cashbox balance /
      // movements aggregates (which sum the manualMovements table separately)
      // do not double-count it. Party-scoped queries are unaffected (NULL party).
      // C4 fix: double-entry — add a balancing contra leg.
      const isOut = input.direction === "out";
      await tx.insert(ledgerEntries).values([
        {
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "adjustment",
          debit: isOut ? input.amount : 0,
          credit: isOut ? 0 : input.amount,
          currency: input.currency ?? "SYP",
          cashImpact: "none",
          referenceType: "manual_movement",
          referenceId: row.id,
          description:
            input.description ?? `حركة يدوية ${input.type === "capital" ? "رأس مال" : input.type}`,
          createdBy: ctx.userId,
        },
        {
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "adjustment_contra",
          debit: isOut ? 0 : input.amount,
          credit: isOut ? input.amount : 0,
          currency: input.currency ?? "SYP",
          cashImpact: "none",
          referenceType: "manual_movement",
          referenceId: row.id,
          description: `مقابل الحركة اليدوية ${input.type === "capital" ? "رأس مال" : input.type}`,
          createdBy: ctx.userId,
        },
      ]);
      return this.toMovementDomain(row);
    });
  }

  async deleteManualMovement(id: UUID, ctx: TenantContext): Promise<void> {
    return this.db.transaction(async (tx) => {
      // Reverse the accounting trace: cancel the linked ledger row (append-only
      // trigger allows only status → 'cancelled').
      await tx
        .update(ledgerEntries)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: ctx.userId,
        })
        .where(
          and(
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.referenceType, "manual_movement"),
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.status, "active"),
          ),
        );
      await tx
        .delete(manualMovements)
        .where(and(eq(manualMovements.id, id), eq(manualMovements.tenantId, ctx.tenantId)));
    });
  }

  async listManualMovements(ctx: TenantContext): Promise<ManualMovementData[]> {
    const rows = await this.db
      .select()
      .from(manualMovements)
      .where(eq(manualMovements.tenantId, ctx.tenantId))
      .orderBy(desc(manualMovements.createdAt));
    return rows.map((r) => this.toMovementDomain(r));
  }

  async isDayLocked(date: string, ctx: TenantContext): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(dayCloses)
      .where(and(eq(dayCloses.tenantId, ctx.tenantId), eq(dayCloses.date, date)))
      .limit(1);
    return !!row;
  }

  async closeDay(input: CloseDayRequestInput, ctx: TenantContext): Promise<DayCloseData> {
    return this.db.transaction(async (tx) => {
      // Derive opening/in/out from the ledger, never from the client. A cashier
      // 500,000 short could previously post an inflated totalOut and store a
      // difference of 0 — a permanent, attacker-chosen control record.
      const [session] = await tx
        .select()
        .from(cashboxSessions)
        .where(eq(cashboxSessions.tenantId, ctx.tenantId))
        .limit(1);
      const currency = input.currency ?? session?.currency ?? "SYP";
      const opening = session?.openingBalance ?? 0;
      const from = session?.openingDate ?? "0001-01-01";

      const [ledger] = await tx
        .select({
          amountIn: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'in' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
          amountOut: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'out' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.status, "active"),
            inArray(ledgerEntries.cashImpact, ["in", "out"]),
            eq(ledgerEntries.currency, currency),
            sql`${ledgerEntries.date} >= ${from}`,
            sql`${ledgerEntries.date} <= ${input.date}`,
          ),
        );

      const movements = await tx
        .select()
        .from(manualMovements)
        .where(eq(manualMovements.tenantId, ctx.tenantId));
      let mIn = 0;
      let mOut = 0;
      for (const m of movements) {
        if (m.currency !== currency || m.date > input.date || m.date < from) continue;
        if (m.direction === "in") mIn += m.amount;
        else mOut += m.amount;
      }

      const totalIn = Number(ledger?.amountIn ?? 0) + mIn;
      const totalOut = Number(ledger?.amountOut ?? 0) + mOut;
      const entity = DayClose.create({
        date: input.date,
        openingBalance: opening,
        totalIn,
        totalOut,
        counted: input.counted,
        currency,
      });
      const d = entity.toData();

      const [row] = await tx
        .insert(dayCloses)
        .values({
          tenantId: ctx.tenantId,
          date: input.date,
          openingBalance: opening,
          totalIn,
          totalOut,
          expected: d.expected,
          counted: d.counted,
          difference: d.difference,
          currency,
          closedBy: ctx.userId,
        })
        .returning();
      return this.toDayCloseDomain(row);
    });
  }

  async getLastClosing(ctx: TenantContext): Promise<DayCloseData | null> {
    const [row] = await this.db
      .select()
      .from(dayCloses)
      .where(eq(dayCloses.tenantId, ctx.tenantId))
      .orderBy(desc(dayCloses.closedAt))
      .limit(1);
    return row ? this.toDayCloseDomain(row) : null;
  }

  async getClosings(ctx: TenantContext): Promise<DayCloseData[]> {
    const rows = await this.db
      .select()
      .from(dayCloses)
      .where(eq(dayCloses.tenantId, ctx.tenantId))
      .orderBy(desc(dayCloses.closedAt));
    return rows.map((r) => this.toDayCloseDomain(r));
  }

  private toMovementDomain(row: typeof manualMovements.$inferSelect): ManualMovementData {
    return ManualMovement.reconstitute(this.mapMovementRow(row)).toData();
  }

  private mapMovementRow(row: typeof manualMovements.$inferSelect): ManualMovementData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      date: row.date,
      type: row.type as ManualMovementData["type"],
      direction: row.direction as ManualMovementData["direction"],
      amount: row.amount,
      currency: row.currency,
      description: n(row.description),
      notesInternal: n(row.notesInternal),
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
    };
  }

  private toDayCloseDomain(row: typeof dayCloses.$inferSelect): DayCloseData {
    return DayClose.reconstitute(this.mapDayCloseRow(row)).toData();
  }

  private mapDayCloseRow(row: typeof dayCloses.$inferSelect): DayCloseData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      date: row.date,
      openingBalance: row.openingBalance,
      totalIn: row.totalIn,
      totalOut: row.totalOut,
      expected: row.expected,
      counted: row.counted,
      difference: row.difference,
      currency: row.currency,
      closedAt: row.closedAt.toISOString(),
      closedBy: n(row.closedBy),
    };
  }
}
