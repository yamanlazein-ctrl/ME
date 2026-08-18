import { eq, and, ilike, or, sql, desc, asc, gte, lte, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  ILedgerRepository,
  LedgerFilter,
  WriteLedgerEntry,
} from "../../application/ports/ILedgerRepository.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { orders } from "../orm/schemas/order.table.js";
import {
  LedgerEntry,
  type LedgerEntryData,
  type PartyBalance,
  computeReversal,
} from "../../domain/entities/LedgerEntry.js";
import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";

export class PostgresLedgerRepository implements ILedgerRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<LedgerEntryData | null> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.id, id), eq(ledgerEntries.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: LedgerFilter, ctx: TenantContext): Promise<PaginatedResult<LedgerEntryData>> {
    const conditions = [eq(ledgerEntries.tenantId, ctx.tenantId)];
    if (filter.partyId) conditions.push(eq(ledgerEntries.partyId, filter.partyId));
    if (filter.type) conditions.push(eq(ledgerEntries.type, filter.type));
    if (filter.currency) conditions.push(eq(ledgerEntries.currency, filter.currency));
    if (filter.referenceType)
      conditions.push(eq(ledgerEntries.referenceType, filter.referenceType));
    if (filter.referenceId) conditions.push(eq(ledgerEntries.referenceId, filter.referenceId));
    if (filter.fromDate) conditions.push(gte(ledgerEntries.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(ledgerEntries.date, filter.toDate));
    if (filter.search)
      conditions.push(or(ilike(ledgerEntries.description!, `%${filter.search}%`))!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;
    // The list API defaults to newest-first (createdAt DESC). The statement
    // path passes sort=asc so running balances accumulate chronologically
    // (date ASC, createdAt ASC as tiebreaker for same-transaction entries).
    const orderBy =
      filter.sort === "asc"
        ? [asc(ledgerEntries.date), asc(ledgerEntries.createdAt)]
        : [desc(ledgerEntries.createdAt)];

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(ledgerEntries)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(...orderBy),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(ledgerEntries)
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

  async listByParty(partyId: UUID, ctx: TenantContext): Promise<LedgerEntryData[]> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.partyId, partyId), eq(ledgerEntries.tenantId, ctx.tenantId)))
      .orderBy(desc(ledgerEntries.createdAt));
    return rows.map((r) => this.toDomain(r));
  }

  async writeMany(entries: WriteLedgerEntry[], ctx: TenantContext): Promise<LedgerEntryData[]> {
    if (entries.length === 0) return [];
    const rows = await this.db
      .insert(ledgerEntries)
      .values(
        entries.map((e) => ({
          tenantId: ctx.tenantId,
          partyId: e.partyId ?? null,
          date: e.date,
          type: e.type,
          debit: e.debit ?? 0,
          credit: e.credit ?? 0,
          currency: e.currency,
          cashImpact: e.cashImpact,
          referenceType: e.referenceType,
          referenceId: e.referenceId,
          referenceNumber: e.referenceNumber,
          description: e.description,
          createdBy: ctx.userId,
        })),
      )
      .returning();
    return rows.map((r) => this.toDomain(r));
  }

  async cancelByReference(
    referenceType: string,
    referenceId: UUID,
    cancelledBy: string,
    ctx: TenantContext,
  ): Promise<void> {
    // Fix C-4 (forensic audit 2026-08-15, live-reproduced): this used to be
    // a bare SELECT then a bare INSERT on the pool — no transaction, no
    // lock, and because the reversal design deliberately keeps the
    // ORIGINAL rows `status = 'active'` (Q2: "the original row stays
    // active — history is never rewritten"), there is no state flip for a
    // second call to observe. A second call — concurrent, or simply a
    // double-clicked button — re-selects the same active originals and
    // inserts a SECOND full set of reversal rows, over-reversing the
    // party's balance by the full document amount every time it happens.
    //
    // Fix: run the whole thing inside a transaction, serialized per
    // (tenant, referenceType, referenceId) by a transactional Postgres
    // advisory lock — a genuine lock, not just an application-level
    // check — so two concurrent calls for the SAME reference cannot
    // interleave; the second one blocks until the first commits. Once
    // inside the lock, check whether a `type = 'cancellation'` row for
    // this exact reference already exists. If it does, this reference has
    // already been reversed — reject instead of inserting again. This
    // keeps the "original stays active, reversal is a separate immutable
    // row" design intact; it only closes the missing idempotency guard.
    await this.db.transaction(async (tx) => {
      const lockKey = `${ctx.tenantId}:${referenceType}:${referenceId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const alreadyReversed = await tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.referenceType, referenceType),
            eq(ledgerEntries.referenceId, referenceId),
            eq(ledgerEntries.type, "cancellation"),
          ),
        )
        .limit(1);
      if (alreadyReversed.length > 0) {
        throw Object.assign(
          new Error("This reference has already been reversed"),
          { code: "ALREADY_CANCELLED" as const },
        );
      }

      const entries = await tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.referenceType, referenceType),
            eq(ledgerEntries.referenceId, referenceId),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.status, "active"),
          ),
        );

      // Q2 "reversal as a separate row": keep each original entry immutable
      // (append-only) and write a distinct ACTIVE reversal row with opposite
      // signs so the pair nets to zero. The original row stays active — history
      // is never rewritten.
      if (entries.length > 0) {
        await tx.insert(ledgerEntries).values(
          entries.map((e) => {
            const entryData = this.toDomain(e);
            const reversal = computeReversal(entryData);
            return {
              tenantId: ctx.tenantId,
              partyId: e.partyId,
              date: new Date().toISOString().slice(0, 10),
              type: "cancellation" as const,
              debit: reversal.debit,
              credit: reversal.credit,
              currency: e.currency,
              cashImpact: reversal.cashImpact,
              referenceType,
              referenceId,
              referenceNumber: e.referenceNumber,
              description: `إلغاء قيد ${e.referenceNumber ?? referenceId}`,
              createdBy: ctx.userId,
            };
          }),
        );
      }
    });
  }

  async getBalance(partyId: UUID, ctx: TenantContext, currency: string = "SYP"): Promise<PartyBalance> {
    const rows = await this.db
      .select({
        debit: sql<number>`COALESCE(SUM(${ledgerEntries.debit}), 0)`,
        credit: sql<number>`COALESCE(SUM(${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.partyId, partyId),
          eq(ledgerEntries.tenantId, ctx.tenantId),
          eq(ledgerEntries.status, "active"),
          eq(ledgerEntries.currency, currency),
        ),
      );

    const d = Number(rows[0]?.debit ?? 0);
    const c = Number(rows[0]?.credit ?? 0);
    return { partyId, totalDebit: d, totalCredit: c, balance: d - c };
  }

  async getBalanceByDate(partyId: UUID, date: string, ctx: TenantContext, currency: string = "SYP"): Promise<PartyBalance> {
    const rows = await this.db
      .select({
        debit: sql<number>`COALESCE(SUM(${ledgerEntries.debit}), 0)`,
        credit: sql<number>`COALESCE(SUM(${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.partyId, partyId),
          eq(ledgerEntries.tenantId, ctx.tenantId),
          eq(ledgerEntries.status, "active"),
          eq(ledgerEntries.currency, currency),
          sql`${ledgerEntries.date} <= ${date}`,
        ),
      );

    const d = Number(rows[0]?.debit ?? 0);
    const c = Number(rows[0]?.credit ?? 0);
    return { partyId, totalDebit: d, totalCredit: c, balance: d - c };
  }

  async getCashMovementsOn(
    fromDate: string,
    toDate: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<{ in: number; out: number }> {
    const rows = await this.db
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
          sql`${ledgerEntries.date} >= ${fromDate}`,
          sql`${ledgerEntries.date} <= ${toDate}`,
        ),
      );
    return {
      in: Number(rows[0]?.amountIn ?? 0),
      out: Number(rows[0]?.amountOut ?? 0),
    };
  }

  async getDocumentTimeline(
    referenceType: string,
    referenceId: UUID,
    ctx: TenantContext,
  ): Promise<LedgerEntryData[]> {
    // Ledger rows directly linked to the document...
    const directRows = await this.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenantId),
          eq(ledgerEntries.referenceType, referenceType),
          eq(ledgerEntries.referenceId, referenceId),
        ),
      );

    // ...plus rows linked through vouchers that reference this invoice
    // (e.g. a sale invoice's linked RCP-<no> receipt voucher, whose ledger row
    // carries referenceType=receipt_in / referenceId=<voucher.id>).
    let linkedRows: (typeof ledgerEntries.$inferSelect)[] = [];
    if (referenceType === "sales_invoice" || referenceType === "purchase_invoice") {
      const voucherIds = await this.db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.invoiceId, referenceId as string),
            eq(vouchers.tenantId, ctx.tenantId),
          ),
        );
      if (voucherIds.length > 0) {
        const vids = voucherIds.map((v) => v.id as UUID);
        linkedRows = await this.db
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, ctx.tenantId),
              inArray(ledgerEntries.referenceId, vids),
              inArray(ledgerEntries.referenceType, ["receipt_in", "payment_out"]),
            ),
          );
      }
    }

    const all = [...directRows, ...linkedRows];
    all.sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return all.map((r) => this.toDomain(r));
  }

  async getDocumentGraph(
    documentType: "invoice" | "voucher" | "return" | "order",
    documentId: UUID,
    ctx: TenantContext,
  ): Promise<unknown> {
    const T = ctx.tenantId;
    // 1. The document's own ledger timeline (any referenceType matching it).
    const ownRows = await this.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, T),
          eq(ledgerEntries.referenceId, documentId as string),
          inArray(ledgerEntries.referenceType, [
            "sales_invoice",
            "purchase_invoice",
            "receipt_in",
            "payment_out",
            "purchase_return",
            "sales_return",
            "expense",
            "printing_charge",
            "settlement",
            "manual",
          ]),
        ),
      );

    let timeline: LedgerEntryData[] = ownRows.map((r) => this.toDomain(r));
    let vouchersList: { id: UUID; number: string; kind: string; date: string; amount: number; method: string; status: string }[] = [];
    let returnsList: { id: UUID; number: string; kind: string; date: string; status: string; reason: string }[] = [];
    let orderLink: { id: UUID; code: string; status: string; date: string } | null = null;

    if (documentType === "invoice") {
      // Vouchers referencing this invoice (incl. linked RCP-<no> receipts).
      const vs = await this.db
        .select({
          id: vouchers.id,
          number: vouchers.number,
          kind: vouchers.kind,
          date: vouchers.date,
          amount: vouchers.amount,
          method: vouchers.method,
          status: vouchers.status,
        })
        .from(vouchers)
        .where(and(eq(vouchers.invoiceId, documentId as string), eq(vouchers.tenantId, T)));
      vouchersList = vs;

      // Returns against this invoice.
      const rs = await this.db
        .select({
          id: returns.id,
          number: returns.number,
          kind: returns.kind,
          date: returns.date,
          status: returns.status,
          reason: returns.reason,
        })
        .from(returns)
        .where(
          and(
            eq(returns.originalInvoiceId, documentId as string),
            eq(returns.tenantId, T),
          ),
        );
      returnsList = rs;

      // Order fulfilled by this invoice.
      const os = await this.db
        .select({ id: orders.id, code: orders.code, status: orders.status, date: orders.date })
        .from(orders)
        .where(and(eq(orders.fulfilledInvoiceId, documentId as string), eq(orders.tenantId, T)))
        .limit(1);
      orderLink = os[0] ?? null;

      // Fold voucher/return ledger rows into the timeline too.
      const extraRefIds = [...vouchersList.map((v) => v.id), ...returnsList.map((r) => r.id)];
      if (extraRefIds.length > 0) {
        const extra = await this.db
          .select()
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, T),
              inArray(ledgerEntries.referenceId, extraRefIds),
              inArray(ledgerEntries.referenceType, ["receipt_in", "payment_out", "purchase_return", "sales_return"]),
            ),
          );
        timeline = [...timeline, ...extra.map((r) => this.toDomain(r))];
      }
    }

    timeline.sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return {
      documentType,
      documentId,
      timeline,
      vouchers: vouchersList,
      returns: returnsList,
      order: orderLink,
    };
  }

  private toDomain(row: typeof ledgerEntries.$inferSelect): LedgerEntryData {
    return LedgerEntry.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof ledgerEntries.$inferSelect): LedgerEntryData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      partyId: row.partyId,
      date: row.date,
      type: row.type as LedgerEntryData["type"],
      debit: row.debit ?? 0,
      credit: row.credit ?? 0,
      currency: row.currency,
      cashImpact: row.cashImpact as LedgerEntryData["cashImpact"],
      referenceType: n(row.referenceType),
      referenceId: n(row.referenceId),
      referenceNumber: n(row.referenceNumber),
      description: n(row.description),
      status: row.status as LedgerEntryData["status"],
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
      cancellationReferenceId: n(row.cancellationReferenceId),
    };
  }
}
