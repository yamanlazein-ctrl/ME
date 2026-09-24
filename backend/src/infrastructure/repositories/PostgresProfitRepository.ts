import { eq, and, sql, gte, lte } from "drizzle-orm";
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
import { expenses } from "../orm/schemas/expense.table.js";
import { parties } from "../orm/schemas/party.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";

import { localToday } from "../utils/localDate.js";
/**
 * PostgresProfitRepository — net profit from live data.
 *
 *   netProfit = salesRevenue − COGS − expenses
 *
 * Period rules (OLD-PLAN 2ب):
 *   - Sale invoices contribute when invoice.date ∈ period.
 *   - Returns reduce the period when returns.date ∈ period (not invoice date).
 *   - COGS: posted cogs_expense ledger first; else qty × invoice_lines.cost_per_kg
 *     (never live rolls.price_per_kg).
 */
export class PostgresProfitRepository implements IProfitRepository {
  constructor(private readonly db: DB) {}

  private dateRange(query: ProfitQuery) {
    const conds: ReturnType<typeof gte>[] = [];
    if (query.fromDate) conds.push(gte(invoices.date, query.fromDate) as ReturnType<typeof gte>);
    if (query.toDate) conds.push(lte(invoices.date, query.toDate) as ReturnType<typeof gte>);
    return conds;
  }

  private returnDateRange(query: ProfitQuery) {
    const conds: ReturnType<typeof gte>[] = [];
    if (query.fromDate) conds.push(gte(returns.date, query.fromDate) as ReturnType<typeof gte>);
    if (query.toDate) conds.push(lte(returns.date, query.toDate) as ReturnType<typeof gte>);
    return conds;
  }

  private expenseDateRange(query: ProfitQuery) {
    const conds: ReturnType<typeof gte>[] = [];
    if (query.fromDate) conds.push(gte(expenses.date, query.fromDate) as ReturnType<typeof gte>);
    if (query.toDate) conds.push(lte(expenses.date, query.toDate) as ReturnType<typeof gte>);
    return conds;
  }

  /** Per-invoice revenue + COGS for active sale invoices in the period (no return subtraction). */
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

    // cost_per_kg only — never live roll price (legacy rows backfilled by 20261008).
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
        lineCogs: sql<number>`COALESCE(SUM(
          ROUND(${invoiceLines.quantityKg}::numeric * COALESCE(${invoiceLines.costPerKg}, 0)::numeric, 2)
        ), 0)`,
        ledgerCogs: sql<number>`COALESCE((
          SELECT SUM(${ledgerEntries.debit} - ${ledgerEntries.credit})
          FROM ${ledgerEntries}
          WHERE ${ledgerEntries.tenantId} = ${invoices.tenantId}
            AND ${ledgerEntries.status} = 'active'
            AND ${ledgerEntries.type} = 'cogs_expense'
            AND ${ledgerEntries.referenceType} = 'sales_invoice'
            AND ${ledgerEntries.referenceId} = ${invoices.id}
        ), 0)`,
      })
      .from(invoices)
      .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
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
        invoices.tenantId,
      )
      .orderBy(sql`${invoices.date} DESC, ${invoices.number} DESC`);

    return rows.map((r) => {
      const ledger = Number(r.ledgerCogs);
      const rawCogs = ledger !== 0 ? ledger : Number(r.lineCogs);
      return {
        invoiceId: r.invoiceId,
        number: r.number,
        date: r.date,
        partyId: r.partyId,
        partyName: r.partyName ?? "",
        currency: r.currency,
        revenue: Math.max(0, Number(r.revenue) - Number(r.discount)),
        cogs: Math.max(0, rawCogs),
      };
    });
  }

  /**
   * Sale returns whose returns.date falls in the query window.
   * Affects the period even when the original invoice is outside it.
   */
  private async getPeriodReturnRows(
    query: ProfitQuery,
    ctx: TenantContext,
  ): Promise<
    Array<{
      returnId: string;
      number: string;
      date: string;
      originalInvoiceId: string | null;
      currency: string;
      revenue: number;
      cogs: number;
    }>
  > {
    const dateConds = this.returnDateRange(query);
    const base = and(
      eq(returns.tenantId, ctx.tenantId),
      eq(returns.status, "active"),
      eq(returns.kind, "sale"),
      ...dateConds,
      ...(query.currency ? [eq(returns.currency, query.currency)] : []),
    );

    const revRows = await this.db
      .select({
        returnId: returns.id,
        number: returns.number,
        date: returns.date,
        originalInvoiceId: returns.originalInvoiceId,
        currency: returns.currency,
        revenue: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
        cogs: sql<number>`COALESCE((
          SELECT SUM(${ledgerEntries.credit} - ${ledgerEntries.debit})
          FROM ${ledgerEntries}
          WHERE ${ledgerEntries.tenantId} = ${returns.tenantId}
            AND ${ledgerEntries.status} = 'active'
            AND ${ledgerEntries.type} = 'cogs_expense'
            AND ${ledgerEntries.referenceId} = ${returns.id}
        ), 0)`,
      })
      .from(returns)
      .leftJoin(returnLines, eq(returnLines.returnId, returns.id))
      .where(base)
      .groupBy(
        returns.id,
        returns.number,
        returns.date,
        returns.originalInvoiceId,
        returns.currency,
        returns.tenantId,
      );

    return revRows.map((r) => ({
      returnId: r.returnId,
      number: r.number,
      date: r.date,
      originalInvoiceId: r.originalInvoiceId,
      currency: r.currency,
      revenue: Number(r.revenue),
      cogs: Math.max(0, Number(r.cogs)),
    }));
  }

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
    returnRows: Array<{ currency: string; revenue: number; cogs: number }>,
    expenseMap: Map<string, number>,
  ): ProfitSummaryByCurrency[] {
    const byCurrency = new Map<
      string,
      {
        salesRevenue: number;
        cogs: number;
        invoiceCount: number;
        returnCount: number;
      }
    >();

    for (const r of invoiceRows) {
      const cur = byCurrency.get(r.currency) ?? {
        salesRevenue: 0,
        cogs: 0,
        invoiceCount: 0,
        returnCount: 0,
      };
      cur.salesRevenue += r.revenue;
      cur.cogs += r.cogs;
      cur.invoiceCount += 1;
      byCurrency.set(r.currency, cur);
    }

    for (const r of returnRows) {
      const cur = byCurrency.get(r.currency) ?? {
        salesRevenue: 0,
        cogs: 0,
        invoiceCount: 0,
        returnCount: 0,
      };
      cur.salesRevenue -= r.revenue;
      cur.cogs -= r.cogs;
      cur.returnCount += 1;
      byCurrency.set(r.currency, cur);
    }

    const result: ProfitSummaryByCurrency[] = [];
    for (const [currency, agg] of byCurrency) {
      // Allow negative period revenue/COGS when returns in the window exceed period sales
      // (e.g. 2027 return of a 2024 invoice with no 2027 sales).
      const salesRevenue = agg.salesRevenue;
      const cogsAmt = agg.cogs;
      const expensesAmount = expenseMap.get(currency) ?? 0;
      const grossProfit = salesRevenue - cogsAmt;
      const netProfit = grossProfit - expensesAmount;
      const marginBase = Math.abs(salesRevenue) > 0 ? salesRevenue : 0;
      const marginPercent = marginBase !== 0 ? (grossProfit / marginBase) * 100 : 0;
      result.push({
        currency,
        salesRevenue,
        cogs: cogsAmt,
        expenses: expensesAmount,
        grossProfit,
        netProfit,
        marginPercent: Math.round(marginPercent * 100) / 100,
        invoiceCount: agg.invoiceCount,
        returnCount: agg.returnCount,
      });
    }

    const order = ["SYP", "USD", "EUR"];
    result.sort((a, b) => {
      const ia = order.indexOf(a.currency);
      const ib = order.indexOf(b.currency);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    return result;
  }

  async getSummary(query: ProfitQuery, ctx: TenantContext): Promise<ProfitSummary> {
    const [invoiceRows, returnRows, expenseMap, debts] = await Promise.all([
      this.getInvoiceProfitRows(query, ctx),
      this.getPeriodReturnRows(query, ctx),
      this.getExpenseTotals(query, ctx),
      this.getDebts(query, ctx),
    ]);

    const byCurrency = this.buildSummary(invoiceRows, returnRows, expenseMap);
    return {
      byCurrency,
      totalReceivables: debts.filter((d) => d.kind === "receivable"),
      totalPayables: debts.filter((d) => d.kind === "payable"),
    };
  }

  async getDetails(query: ProfitQuery, ctx: TenantContext): Promise<ProfitDetails> {
    const [invoiceRows, returnRows, expenseMap, debts, expenseRows] = await Promise.all([
      this.getInvoiceProfitRows(query, ctx),
      this.getPeriodReturnRows(query, ctx),
      this.getExpenseTotals(query, ctx),
      this.getDebts(query, ctx),
      this.getExpenseRows(query, ctx),
    ]);

    const byCurrency = this.buildSummary(invoiceRows, returnRows, expenseMap);

    const detailLines: ProfitDetailLine[] = invoiceRows.map((r) => {
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
      invoiceLines: detailLines,
      returnAdjustments: returnRows.map((r) => ({
        returnId: r.returnId,
        number: r.number,
        date: r.date,
        originalInvoiceId: r.originalInvoiceId,
        currency: r.currency,
        revenue: r.revenue,
        cogs: r.cogs,
      })),
      expenses: expenseRows,
      receivables: debts.filter((d) => d.kind === "receivable"),
      payables: debts.filter((d) => d.kind === "payable"),
    };
  }

  private async getDebts(query: ProfitQuery, ctx: TenantContext): Promise<DebtItem[]> {
    const dateConds = this.dateRange(query);
    const invoiceBase = and(
      eq(invoices.tenantId, ctx.tenantId),
      eq(invoices.status, "active"),
      ...dateConds,
      ...(query.currency ? [eq(invoices.currency, query.currency)] : []),
    );

    const returnTotalSql = sql<number>`COALESCE((
      SELECT SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg})
      FROM ${returnLines}
      INNER JOIN ${returns} ON ${returns.id} = ${returnLines.returnId}
      WHERE ${returns.originalInvoiceId} = ${invoices.id}
        AND ${returns.tenantId} = ${invoices.tenantId}
        AND ${returns.status} = 'active'
    ), 0)`;

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
        paid: invoices.paid,
        returns: returnTotalSql,
      })
      .from(invoices)
      .leftJoin(parties, eq(parties.id, invoices.partyId))
      .where(invoiceBase);

    const today = localToday();
    const out: DebtItem[] = [];
    for (const r of rows) {
      const total = Number(r.total);
      const paid = Number(r.paid);
      const returnsAmount = Number(r.returns);
      const remaining = total - paid - returnsAmount;
      if (remaining <= 0) continue;
      const kind: DebtItem["kind"] = r.invoiceType === "sale" ? "receivable" : "payable";
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

    const balRows = await this.db
      .select({
        partyId: ledgerEntries.partyId,
        currency: ledgerEntries.currency,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)::text`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenantId),
          eq(ledgerEntries.status, "active"),
          ...(query.currency ? [eq(ledgerEntries.currency, query.currency)] : []),
        ),
      )
      .groupBy(ledgerEntries.partyId, ledgerEntries.currency);

    const balByKey = new Map<string, { deb: number; cred: number }>();
    for (const r of balRows) {
      if (!r.partyId) continue;
      const key = `${r.partyId}|${r.currency}`;
      const prev = balByKey.get(key) ?? { deb: 0, cred: 0 };
      prev.deb += Number(r.debit);
      prev.cred += Number(r.credit);
      balByKey.set(key, prev);
    }

    const groups = new Map<string, DebtItem[]>();
    for (const it of out) {
      const key = `${it.partyId}|${it.currency}`;
      const arr = groups.get(key) ?? [];
      arr.push(it);
      groups.set(key, arr);
    }

    for (const items of groups.values()) {
      const bal = balByKey.get(`${items[0].partyId}|${items[0].currency}`);
      if (!bal) continue;
      const isPayable = items[0].kind === "payable";
      const target = isPayable ? bal.cred - bal.deb : bal.deb - bal.cred;
      items.sort((a, b) => (a.date < b.date ? -1 : 1));
      let diff = target - items.reduce((s, it) => s + it.remaining, 0);
      for (const it of items) {
        if (diff >= 0) break;
        const take = Math.min(it.remaining, Math.abs(diff));
        it.remaining -= take;
        diff += take;
      }
    }

    return out.filter((it) => it.remaining > 0).sort((a, b) => b.remaining - a.remaining);
  }

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
