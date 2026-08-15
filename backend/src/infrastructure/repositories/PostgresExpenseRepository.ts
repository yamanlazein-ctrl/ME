import { eq, and, desc, ilike, or, sql, inArray, gte, lte } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IExpenseRepository,
  ExpenseFilter,
} from "../../application/ports/IExpenseRepository.js";
import { expenses } from "../orm/schemas/expense.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { cashboxSessions, manualMovements } from "../orm/schemas/cashbox.table.js";
import {
  Expense,
  type ExpenseData,
  type CreateExpenseInput,
} from "../../domain/entities/Expense.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresExpenseRepository implements IExpenseRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<ExpenseData | null> {
    const rows = await this.db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: ExpenseFilter, ctx: TenantContext): Promise<PaginatedResult<ExpenseData>> {
    const conditions = [eq(expenses.tenantId, ctx.tenantId)];
    if (filter.category) conditions.push(eq(expenses.category, filter.category));
    if (filter.status) conditions.push(eq(expenses.status, filter.status));
    if (filter.fromDate) conditions.push(gte(expenses.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(expenses.date, filter.toDate));
    if (filter.search)
      conditions.push(
        or(
          ilike(expenses.number!, `%${filter.search}%`),
          ilike(expenses.description!, `%${filter.search}%`),
        )!,
      );
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(expenses)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(expenses.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(expenses)
        .where(where),
    ]);

    return {
      data: dataRows.map((r) => this.toDomain(r)),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(
    input: CreateExpenseInput,
    autoNumber: string,
    ctx: TenantContext,
  ): Promise<ExpenseData> {
    return this.db.transaction(async (tx) => {
      // Problem 3 fix: default paidFromCashbox to true ONCE and reuse it, so the
      // ledger cashImpact flag matches what is actually persisted (the raw input
      // field is undefined when omitted, which previously made transfer-method
      // expenses silently bypass the cashbox).
      const paidFromCashbox = input.paidFromCashbox ?? true;
      const currency = input.currency ?? "SYP";
      const isCash = input.method === "cash" || paidFromCashbox === true;
      // CB.BC.02 fix: an expense that reduces the cashbox must not overdraw it.
      // Only enforced when a cashbox session exists for this exact currency
      // (no session / different currency → no meaningful balance to check,
      // preserving legacy behaviour). Mirrors GET /cashbox/balance/:date.
      if (isCash) {
        const [session] = await tx
          .select()
          .from(cashboxSessions)
          .where(eq(cashboxSessions.tenantId, ctx.tenantId))
          .limit(1);
        if (session && session.currency === currency) {
          const from = session.openingDate;
          const [agg] = await tx
            .select({
              amountIn: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'in' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
              amountOut: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.cashImpact} = 'out' THEN ${ledgerEntries.debit} + ${ledgerEntries.credit} ELSE 0 END), 0)`,
            })
            .from(ledgerEntries)
            .where(
              and(
                eq(ledgerEntries.tenantId, ctx.tenantId),
                eq(ledgerEntries.status, "active"),
                eq(ledgerEntries.currency, currency),
                inArray(ledgerEntries.cashImpact, ["in", "out"]),
                sql`${ledgerEntries.date} >= ${from}`,
              ),
            );
          const manualRows = await tx
            .select({
              direction: manualMovements.direction,
              amount: manualMovements.amount,
              currency: manualMovements.currency,
            })
            .from(manualMovements)
            .where(eq(manualMovements.tenantId, ctx.tenantId));
          let mIn = 0;
          let mOut = 0;
          for (const m of manualRows) {
            if (m.currency !== currency) continue;
            if (m.direction === "in") mIn += m.amount;
            else mOut += m.amount;
          }
          const balance =
            session.openingBalance +
            Number(agg?.amountIn ?? 0) +
            mIn -
            Number(agg?.amountOut ?? 0) -
            mOut;
          if (balance - input.amount < 0) {
            throw new Error(
              `رصيد الصندوق غير كافٍ (${balance.toLocaleString("en-US")} ${currency}) لصرف ${input.amount.toLocaleString("en-US")} ${currency}`,
            );
          }
        }
      }
      const [row] = await tx
        .insert(expenses)
        .values({
          tenantId: ctx.tenantId,
          number: autoNumber,
          category: input.category,
          description: input.description,
          amount: input.amount,
          currency,
          date: input.date,
          method: input.method,
          paidFromCashbox,
          notesPrint: input.notesPrint,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
        })
        .returning();

      // C4 fix: double-entry. Expense leg (debit, no cash impact) + balancing
      // cash leg (credit, carries cashImpact so the cashbox still reads it).
      await tx.insert(ledgerEntries).values([
        {
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "expense",
          debit: input.amount,
          credit: 0,
          currency,
          cashImpact: "none",
          referenceType: "expense",
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `Expense ${autoNumber}: ${input.category} - ${input.description}`,
          createdBy: ctx.userId,
        },
        {
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "cash",
          debit: 0,
          credit: input.amount,
          currency,
          cashImpact: isCash ? "out" : "none",
          referenceType: "expense",
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `Cash paid ${autoNumber}`,
          createdBy: ctx.userId,
        },
      ]);

      return this.toDomain(row);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<ExpenseData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(expenses)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
        })
        .where(
          and(
            eq(expenses.id, id),
            eq(expenses.tenantId, ctx.tenantId),
            eq(expenses.status, "active"),
          ),
        )
        .returning();
      if (!row) throw new Error("Expense not found or already cancelled");

      // Reverse the linked ledger entry atomically when the expense is cancelled
      // (mirrors PostgresReturnRepository.cancel / PostgresVoucherRepository.cancel).
      await tx
        .update(ledgerEntries)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
        })
        .where(
          and(
            eq(ledgerEntries.referenceType, "expense"),
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.status, "active"),
          ),
        );

      return this.toDomain(row);
    });
  }

  private toDomain(row: typeof expenses.$inferSelect): ExpenseData {
    return Expense.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof expenses.$inferSelect): ExpenseData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      number: row.number,
      category: row.category,
      description: row.description,
      amount: row.amount,
      currency: row.currency,
      date: row.date,
      method: row.method,
      paidFromCashbox: row.paidFromCashbox,
      status: row.status as ExpenseData["status"],
      notesPrint: n(row.notesPrint),
      notesInternal: n(row.notesInternal),
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
    };
  }
}
