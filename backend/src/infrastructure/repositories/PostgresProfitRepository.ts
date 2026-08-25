import { eq, and, sql, gte, lte, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IProfitRepository } from "../../application/ports/IProfitRepository.js";
import type {
  ProfitSummary,
  ProfitDetails,
  ProfitQuery,
  ProfitSummaryByCurrency,
  ProfitDetailLine,
  DebtItem,
} from "../../domain/entities/Profit.js";
import type { TenantContext } from "../../domain/types/index.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { expenses } from "../orm/schemas/expense.table.js";
import { parties } from "../orm/schemas/party.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";

/**
 * PostgresProfitRepository — computes net profit directly from live data.
 *
 * STRICT ACCOUNTING EQUATION (never deviate):
 *   netProfit = salesRevenue − COGS − expenses
 *
 *   salesRevenue = SUM(invoices.subtotal − invoices.discount)  [active SALE]
 *   COGS = SUM(invoice_lines.quantityKg × COALESCE(costPerKg, rolls.pricePerKg))
 *          [same active SALE invoices — costPerKg snapshot is authoritative]
 *   expenses = SUM(expenses.amount)  [active expenses in period]
 *
 * RECEIVABLES/PAYABLES ARE ASSETS/LIABILITIES, NOT EXPENSES — they are
 * returned separately and NEVER subtracted from netProfit.
 *
 * Multi-currency: every aggregate groups by currency. Currencies are NEVER
 * mixed, summed, or converted.
 */
export class PostgresProfitRepository implements IProfitRepository {
  constructor(private readonly db: DB) {}

  private dateRange(query: ProfitQuery) {
    const conds: ReturnType<typeof gte>[] = [];
    if (query.fromDate) conds.push(gte(invoices.date, query.fromDate) as ReturnType<typeof gte>);
    if (query.toDate) conds.push(lte(invoices.date, query.toDate) as ReturnType<typeof gte>);
    return conds;
  }

  private expenseDateRange(query: ProfitQuery) {
    const conds: ReturnType<typeof gte>[] = [];
    if (query.fromDate) conds.push(gte(expenses.date, query.fromDate) as ReturnType<typeof gte>);
    if (query.toDate) conds.push(lte(expenses.date, query.toDate) as ReturnType<typeof gte>);
    return conds;
  }

  /**
   * Per-invoice revenue + COGS for active sale invoices in the period.
   * Uses costPerKg snapshot (fallback to roll price for pre-migration rows).
   */
  private async getInvoiceProfitRows(
    query: ProfitQuery,
    ctx: TenantContext,
  ): Promise<
    Array<{
      invoiceId: string;
      number: string;
      date: string;
      partyId: string;
      partyName: string;
      currency: string;
      revenue: number;
      cogs: number;
    }>
  > {
    const dateConds = this.dateRange(query);
    const saleBase = and(
      eq(invoices.tenantId, ctx.tenantId),
      eq(invoices.type, "sale"),
      eq(invoices.status, "active"),
      ...dateConds,
      ...(query.currency ? [eq(invoices.currency, query.currency)] : []),
    );

    const rows = await this.db
      .select({
        invoiceId: invoices.id,
        number: invoices.number,
        date: invoices.date,
        partyId: invoices.partyId,
        partyName: parties.name,
        currency: invoices.currency,
        revenue: invoices.subtotal,
        discount: invoices.discount,
        cogs: sql<number>`COALESCE(SUM(
          ROUND(${invoiceLines.quantityKg}::numeric * COALESCE(${invoiceLines.costPerKg}, ${rolls.pricePerKg})::numeric)
        ), 0)`,
      })
      .from(invoices)
      .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .innerJoin(rolls, eq(rolls.id, invoiceLines.rollId))
      .leftJoin(parties, eq(parties.id, invoices.partyId))
      .where(saleBase)
      .groupBy(
        invoices.id,
        invoices.number,
        invoices.date,
        invoices.partyId,
        parties.name,
        invoices.currency,
        invoices.subtotal,
        invoices.discount,
      )
      .orderBy(sql`${invoices.date} DESC, ${invoices.number} DESC`);

    // BUG-04 fix: active sale returns must reduce BOTH the revenue AND the COGS
    // of their original invoice (previously the report ignored returns entirely
    // and kept showing phantom profit). Returns are valued at the invoice's own
    // cost snapshot (invoice_lines.cost_per_kg → rolls.price_per_kg fallback).
    const returnAdj = await this.getReturnAdjustments(
      rows.map((r) => r.invoiceId),
      ctx,
    );

    return rows.map((r) => {
      const adj = returnAdj.get(r.invoiceId) ?? { revenue: 0, cogs: 0 };
      const revenue = Math.max(0, Number(r.revenue) - Number(r.discount) - adj.revenue);
      const cogs = Math.max(0, Number(r.cogs) - adj.cogs);
      return {
        invoiceId: r.invoiceId,
        number: r.number,
        date: r.date,
        partyId: r.partyId,
        partyName: r.partyName ?? "",
        currency: r.currency,
        // revenue for profit = subtotal − discount (excludes tax + shipping, per P0-LOGIC-3.6d)
        revenue,
        cogs,
      };
    });
  }

  /**
   * BUG-04 fix — per-invoice adjustments for ACTIVE returns linked to it.
   * revenue  = Σ(return_lines.qty × return_lines.pricePerKg)
   * cogs     = Σ(return_lines.qty × COALESCE(invoice_lines.costPerKg, rolls.pricePerKg))
   * matched by rollId within the same invoice.
   */
  private async getReturnAdjustments(
    invoiceIds: string[],
    ctx: TenantContext,
  ): Promise<Map<string, { revenue: number; cogs: number }>> {
    const out = new Map<string, { revenue: number; cogs: number }>();
    if (invoiceIds.length === 0) return out;

    const revRows = await this.db
      .select({
        invoiceId: returns.originalInvoiceId,
        total: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
      })
      .from(returns)
      .innerJoin(returnLines, eq(returnLines.returnId, returns.id))
      .where(
        and(
          eq(returns.tenantId, ctx.tenantId),
          eq(returns.status, "active"),
          inArray(returns.originalInvoiceId, invoiceIds),
        ),
      )
      .groupBy(returns.originalInvoiceId);
    for (const r of revRows) {
      if (r.invoiceId) out.set(r.invoiceId, { revenue: Number(r.total), cogs: 0 });
    }

    // Cost side: match each return line to its invoice line via rollId.
    const retLineRows = await this.db
      .select({
        invoiceId: returns.originalInvoiceId,
        rollId: returnLines.rollId,
        qty: sql<number>`COALESCE(SUM(${returnLines.quantityKg}), 0)`,
      })
      .from(returns)
      .innerJoin(returnLines, eq(returnLines.returnId, returns.id))
      .where(
        and(
          eq(returns.tenantId, ctx.tenantId),
          eq(returns.status, "active"),
          inArray(returns.originalInvoiceId, invoiceIds),
        ),
      )
      .groupBy(returns.originalInvoiceId, returnLines.rollId);

    if (retLineRows.length > 0) {
      const costRows = await this.db
        .select({
          invoiceId: invoices.id,
          rollId: invoiceLines.rollId,
          cost: sql<number>`MAX(COALESCE(${invoiceLines.costPerKg}, ${rolls.pricePerKg}))`,
        })
        .from(invoices)
        .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
        .innerJoin(rolls, eq(rolls.id, invoiceLines.rollId))
        .where(and(eq(invoices.tenantId, ctx.tenantId), inArray(invoices.id, invoiceIds)))
        .groupBy(invoices.id, invoiceLines.rollId);
      const costMap = new Map<string, number>();
      for (const cr of costRows) costMap.set(`${cr.invoiceId}:${cr.rollId}`, Number(cr.cost));

      for (const rl of retLineRows) {
        if (!rl.invoiceId) continue;
        const unitCost = costMap.get(`${rl.invoiceId}:${rl.rollId}`) ?? 0;
        const cur = out.get(rl.invoiceId) ?? { revenue: 0, cogs: 0 };
        cur.cogs += Number(rl.qty) * unitCost;
        out.set(rl.invoiceId, cur);
      }
    }
    return out;
  }

  /** Aggregated expense totals per currency for the period. */
  private async getExpenseTotals(
    query: ProfitQuery,
    ctx: TenantContext,
  ): Promise<Map<string, number>> {
    const dateConds = this.expenseDateRange(query);
    const rows = await this.db
      .select({
        currency: expenses.currency,
        total: sql<number>`COALESCE(SUM(${expenses.amount}), 0)`,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, ctx.tenantId),
          eq(expenses.status, "active"),
          ...dateConds,
          ...(query.currency ? [eq(expenses.currency, query.currency)] : []),
        ),
      )
      .groupBy(expenses.currency);

    return new Map(rows.map((r) => [r.currency, Number(r.total)]));
  }

  private buildSummary(
    invoiceRows: Array<{ currency: string; revenue: number; cogs: number }>,
    expenseMap: Map<string, number>,
  ): ProfitSummaryByCurrency[] {
    const byCurrency = new Map<
      string,
      {
        salesRevenue: number;
        cogs: number;
        invoiceCount: number;
      }
    >();

    for (const r of invoiceRows) {
      const cur = byCurrency.get(r.currency) ?? {
        salesRevenue: 0,
        cogs: 0,
        invoiceCount: 0,
      };
      cur.salesRevenue += r.revenue;
      cur.cogs += r.cogs;
      cur.invoiceCount += 1;
      byCurrency.set(r.currency, cur);
    }

    const result: ProfitSummaryByCurrency[] = [];
    for (const [currency, agg] of byCurrency) {
      const expensesAmount = expenseMap.get(currency) ?? 0;
      const grossProfit = agg.salesRevenue - agg.cogs;
      const netProfit = grossProfit - expensesAmount;
      const marginPercent = agg.salesRevenue > 0 ? (grossProfit / agg.salesRevenue) * 100 : 0;
      result.push({
        currency,
        salesRevenue: agg.salesRevenue,
        cogs: agg.cogs,
        expenses: expensesAmount,
        grossProfit,
        netProfit,
        marginPercent: Math.round(marginPercent * 100) / 100,
        invoiceCount: agg.invoiceCount,
      });
    }

    // Stable ordering: SYP first, then USD, EUR, then alphabetical.
    const order = ["SYP", "USD", "EUR"];
    result.sort((a, b) => {
      const ia = order.indexOf(a.currency);
      const ib = order.indexOf(b.currency);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    return result;
  }

  async getSummary(query: ProfitQuery, ctx: TenantContext): Promise<ProfitSummary> {
    const [invoiceRows, expenseMap, debts] = await Promise.all([
      this.getInvoiceProfitRows(query, ctx),
      this.getExpenseTotals(query, ctx),
      this.getDebts(query, ctx),
    ]);

    const byCurrency = this.buildSummary(invoiceRows, expenseMap);

    // Split debts into receivables (customers owe us) and payables (we owe suppliers)
    const totalReceivables = debts.filter((d) => d.kind === "receivable");
    const totalPayables = debts.filter((d) => d.kind === "payable");

    return { byCurrency, totalReceivables, totalPayables };
  }

  async getDetails(query: ProfitQuery, ctx: TenantContext): Promise<ProfitDetails> {
    const [invoiceRows, expenseMap, debts, expenseRows] = await Promise.all([
      this.getInvoiceProfitRows(query, ctx),
      this.getExpenseTotals(query, ctx),
      this.getDebts(query, ctx),
      this.getExpenseRows(query, ctx),
    ]);

    const byCurrency = this.buildSummary(invoiceRows, expenseMap);

    const invoiceLines: ProfitDetailLine[] = invoiceRows.map((r) => {
      const grossProfit = r.revenue - r.cogs;
      const marginPercent = r.revenue > 0 ? (grossProfit / r.revenue) * 100 : 0;
      return {
        invoiceId: r.invoiceId,
        number: r.number,
        date: r.date,
        partyId: r.partyId,
        partyName: r.partyName,
        currency: r.currency,
        revenue: r.revenue,
        cogs: r.cogs,
        grossProfit,
        marginPercent: Math.round(marginPercent * 100) / 100,
      };
    });

    return {
      byCurrency,
      invoiceLines,
      expenses: expenseRows,
      receivables: debts.filter((d) => d.kind === "receivable"),
      payables: debts.filter((d) => d.kind === "payable"),
    };
  }

  /**
   * Outstanding receivables (unpaid sale invoices) and payables (unpaid entry
   * invoices). These are ASSETS/LIABILITIES — never subtracted from profit.
   *
   * remaining = total − paid(vouchers) − returns
   * Only includes rows where remaining > 0.
   */
  private async getDebts(query: ProfitQuery, ctx: TenantContext): Promise<DebtItem[]> {
    const dateConds = this.dateRange(query);

    // Active sale invoices = receivables; active entry invoices = payables.
    const invoiceBase = and(
      eq(invoices.tenantId, ctx.tenantId),
      eq(invoices.status, "active"),
      ...dateConds,
      ...(query.currency ? [eq(invoices.currency, query.currency)] : []),
    );

    const rows = await this.db
      .select({
        invoiceId: invoices.id,
        number: invoices.number,
        date: invoices.date,
        partyId: invoices.partyId,
        partyName: parties.name,
        currency: invoices.currency,
        total: invoices.total,
        invoiceType: invoices.type,
        partyType: invoices.partyType,
        paid: sql<number>`COALESCE(SUM(${vouchers.amount}) FILTER (WHERE ${vouchers.kind} = 'receipt' AND ${vouchers.status} = 'active'), 0)`,
        returns: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
      })
      .from(invoices)
      .leftJoin(
        vouchers,
        and(
          eq(vouchers.invoiceId, invoices.id),
          eq(vouchers.kind, "receipt"),
          eq(vouchers.status, "active"),
        ),
      )
      .leftJoin(
        returns,
        and(
          eq(returns.originalInvoiceId, invoices.id),
          eq(returns.status, "active"),
        ),
      )
      .leftJoin(returnLines, eq(returnLines.returnId, returns.id))
      .leftJoin(parties, eq(parties.id, invoices.partyId))
      .where(invoiceBase)
      .groupBy(
        invoices.id,
        invoices.number,
        invoices.date,
        invoices.partyId,
        parties.name,
        invoices.currency,
        invoices.total,
        invoices.type,
        invoices.partyType,
      );

    const today = new Date().toISOString().slice(0, 10);
    const out: DebtItem[] = [];
    for (const r of rows) {
      const total = Number(r.total);
      const paid = Number(r.paid);
      const returnsAmount = Number(r.returns);
      const remaining = total - paid - returnsAmount;
      if (remaining <= 0) continue;

      // Receivable: customer owes us (sale invoice). Payable: we owe supplier (entry invoice).
      const kind: DebtItem["kind"] =
        r.invoiceType === "sale" ? "receivable" : "payable";

      // Days overdue = days since invoice date (simple aging).
      const daysOverdue = Math.max(
        0,
        Math.floor((new Date(today).getTime() - new Date(r.date).getTime()) / 86400000),
      );

      out.push({
        invoiceId: r.invoiceId,
        number: r.number,
        date: r.date,
        partyId: r.partyId,
        partyName: r.partyName ?? "",
        currency: r.currency,
        total,
        paid,
        returns: returnsAmount,
        remaining,
        kind,
        daysOverdue,
      });
    }

    return out.sort((a, b) => b.remaining - a.remaining);
  }

  /** Individual expense rows for the details drill-down. */
  private async getExpenseRows(
    query: ProfitQuery,
    ctx: TenantContext,
  ): Promise<
    Array<{
      id: string;
      number: string;
      date: string;
      category: string;
      description: string;
      amount: number;
      currency: string;
    }>
  > {
    const dateConds = this.expenseDateRange(query);
    const rows = await this.db
      .select({
        id: expenses.id,
        number: expenses.number,
        date: expenses.date,
        category: expenses.category,
        description: expenses.description,
        amount: expenses.amount,
        currency: expenses.currency,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, ctx.tenantId),
          eq(expenses.status, "active"),
          ...dateConds,
          ...(query.currency ? [eq(expenses.currency, query.currency)] : []),
        ),
      )
      .orderBy(sql`${expenses.date} DESC`);

    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date,
      category: r.category,
      description: r.description,
      amount: Number(r.amount),
      currency: r.currency,
    }));
  }
}
