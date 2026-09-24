import { eq, and, desc, ilike, or, sql, gte, lte, getTableColumns } from "drizzle-orm";
import { afterCursor, cursorColumns, decodeCursor, keysetOrder, nextCursorOf, type KeysetSpec } from "./keysetPage.js";
import { likeContains } from "../utils/likeEscape.js";
import type { DB } from "../orm/drizzle.js";
import type {
  IExpenseRepository,
  ExpenseFilter,
} from "../../application/ports/IExpenseRepository.js";
import { expenses } from "../orm/schemas/expense.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { assertDayUnlocked } from "./dayLockHelper.js";
import { assertSufficientCashboxBalance } from "./cashboxBalanceHelper.js";
import {
  Expense,
  type ExpenseData,
  type CreateExpenseInput,
} from "../../domain/entities/Expense.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
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
          ilike(expenses.number!, likeContains(filter.search)),
          ilike(expenses.description!, likeContains(filter.search)),
        )!,
      );
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;
    // Keyset mode for "load every row" callers: seek after the cursor instead
    // of OFFSET (constant cost per page, strict total order). keysetPage.ts.
    const keyset: KeysetSpec = { date: expenses.date, createdAt: expenses.createdAt, id: expenses.id };
    const cursor = true ? decodeCursor(filter.cursor) : null;
    const pageWhere = cursor ? and(where, afterCursor(keyset, cursor)) : where;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({ ...getTableColumns(expenses), ...cursorColumns(keyset) })
        .from(expenses)
        .where(pageWhere)
        .limit(limit)
        .offset(cursor ? 0 : offset)
        .orderBy(...keysetOrder(keyset)),
      // Cursor pages skip the COUNT: the caller stops on nextCursor and the
      // first (cursor-less) page already carried the real total.
      cursor
        ? Promise.resolve([{ count: -1 }])
        : this.db
            .select({ count: sql<number>`count(*)` })
            .from(expenses)
            .where(where),
    ]);

    const nextCursor = nextCursorOf(dataRows as unknown as Array<Record<string, unknown>>, limit);
    return {
      data: dataRows.map((r) => this.toDomain(r)),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        // Without a cursor the COUNT decides; a last page hands out no cursor.
        nextCursor: cursor || offset + limit < Number(countRows[0]?.count ?? 0) ? nextCursor : null,
        hasNext: cursor ? nextCursor !== null : offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(
    input: CreateExpenseInput,
    autoNumber: string | undefined,
    ctx: TenantContext,
  ): Promise<ExpenseData> {
    return this.db.transaction(async (tx) => {
      await assertDayUnlocked(tx, ctx.tenantId, input.date);
      // P4: mint the number INSIDE this transaction from the device's reserved
      // block (fail-loud when unprovisioned) so two offline devices can never
      // mint the same number and a guard failure below never burns one. A
      // supplied number (sync replay) goes through the pre-allocated path,
      // which honors it verbatim AND raises the sequence floor.
      const number = await allocateDocumentNumber(tx, "expense", ctx.tenantId, {
        preAllocatedNumber: autoNumber ?? null,
        syncDeviceId: ctx.syncDeviceId,
      });
      // Problem 3 fix: default paidFromCashbox to true ONCE and reuse it, so the
      // ledger cashImpact flag matches what is actually persisted (the raw input
      // field is undefined when omitted, which previously made transfer-method
      // expenses silently bypass the cashbox).
      const paidFromCashbox = input.paidFromCashbox ?? true;
      const currency = input.currency ?? "SYP";
      const isCash = input.method === "cash" || paidFromCashbox === true;
      // CB.BC.02 / F06 fix: an expense that reduces the cashbox must not
      // overdraw it. Previously this was a hand-rolled, non-atomic recompute
      // that (a) grabbed an arbitrary cashbox session row instead of the one
      // for THIS currency, silently skipping the check whenever the tenant
      // had sessions in more than one currency, and (b) took no advisory
      // lock, so two concurrent cash expenses could both read the same
      // balance and both pass. Reuse the same guard vouchers/manual
      // movements use — race-safe and always per-currency.
      if (isCash) {
        await assertSufficientCashboxBalance(tx, ctx, currency, input.date, input.amount);
      }
      const [row] = await tx
        .insert(expenses)
        .values({
          ...(input.preAllocatedId ? { id: input.preAllocatedId } : {}),
          tenantId: ctx.tenantId,
          number,
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
          clientOperationId: ctx.clientOperationId ?? null,
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
          referenceNumber: number,
          description: `مصروف ${number}: ${input.category} - ${input.description}`,
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
          referenceNumber: number,
          description: `نقدية مدفوعة ${number}`,
          createdBy: ctx.userId,
        },
      ]);

      return this.toDomain(row);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext, expectedVersion: number): Promise<ExpenseData> {
    return this.db.transaction(async (tx) => {
      // P0-001: lock the row first for version check
      const [currentRow] = await tx
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.id, id),
            eq(expenses.tenantId, ctx.tenantId),
            eq(expenses.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!currentRow) throw new Error("Expense not found or already cancelled");
      // P0-001: optimistic concurrency — fail fast if version mismatch
      if (currentRow.version !== expectedVersion) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${currentRow.version}`), {
          code: "STALE_VERSION" as const,
        });
      }

      const [row] = await tx
        .update(expenses)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
          updatedAt: new Date(),
          version: sql`${expenses.version} + 1`,
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
      version: row.version ?? 1,
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      updatedAt: row.updatedAt?.toISOString() ?? row.createdAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
    };
  }
}
