import { eq, and, sql, desc, gte, gt, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IDashboardRepository } from "../../application/ports/IDashboardRepository.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { orders } from "../orm/schemas/order.table.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { cashboxSessions, dayCloses, manualMovements } from "../orm/schemas/cashbox.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { notifications } from "../orm/schemas/notification.table.js";
import { auditLogs } from "../orm/schemas/audit-log.table.js";
import { parties } from "../orm/schemas/party.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { companyProfiles } from "../orm/schemas/company-profile.table.js";
import type { DashboardData } from "../../domain/entities/Dashboard.js";
import type { TenantContext } from "../../domain/types/index.js";

export class PostgresDashboardRepository implements IDashboardRepository {
  constructor(private readonly db: DB) {}

  async getDashboard(ctx: TenantContext): Promise<DashboardData> {
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const base = eq(invoices.tenantId, ctx.tenantId);

    const todaySalesRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${invoices.total}), 0)`,
        count: sql<number>`COUNT(*)`,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(base, eq(invoices.type, "sale"), eq(invoices.date, today), eq(invoices.status, "active")),
      )
      .groupBy(invoices.currency);

    const todaySalesByCurrency: Record<string, { total: number; count: number }> = {};
    for (const r of todaySalesRows) {
      todaySalesByCurrency[r.currency] = { total: Number(r.total), count: Number(r.count) };
    }

    // FIX 1.1: week/month sales are also grouped by currency to prevent mixing
    // SYP + USD aggregates. Returns { byCurrency: { SYP: {total, count}, ... } }.
    const weekSalesRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${invoices.total}), 0)`,
        count: sql<number>`COUNT(*)`,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(base, eq(invoices.type, "sale"), gte(invoices.date, weekStart), eq(invoices.status, "active")),
      )
      .groupBy(invoices.currency);
    const weekSalesByCurrency: Record<string, { total: number; count: number }> = {};
    for (const r of weekSalesRows) {
      weekSalesByCurrency[r.currency] = { total: Number(r.total), count: Number(r.count) };
    }

    const monthSalesRows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${invoices.total}), 0)`,
        count: sql<number>`COUNT(*)`,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(base, eq(invoices.type, "sale"), gte(invoices.date, monthStart), eq(invoices.status, "active")),
      )
      .groupBy(invoices.currency);
    const monthSalesByCurrency: Record<string, { total: number; count: number }> = {};
    for (const r of monthSalesRows) {
      monthSalesByCurrency[r.currency] = { total: Number(r.total), count: Number(r.count) };
    }

    const [outstanding] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.status, "open")));

    // Count fabrics where total remaining stock of in_stock rolls
    // is below their configured minStockKg threshold.
    const lowStockRows = await this.db
      .select({ fabricId: fabrics.id })
      .from(fabrics)
      .innerJoin(colors, and(eq(colors.fabricId, fabrics.id), eq(colors.tenantId, ctx.tenantId)))
      .innerJoin(
        rolls,
        and(
          eq(rolls.colorId, colors.id),
          eq(rolls.tenantId, ctx.tenantId),
          eq(rolls.status, "in_stock"),
        ),
      )
      .where(
        and(
          eq(fabrics.tenantId, ctx.tenantId),
          gt(fabrics.minStockKg, sql`0`),
        ),
      )
      .groupBy(fabrics.id, fabrics.minStockKg)
      .having(sql`COALESCE(SUM(${rolls.remainingKg}::numeric), 0) < ${fabrics.minStockKg}`);
    const lowStockCount = lowStockRows.length;

    // FIX 1.1: topCustomers revenue is also grouped by currency to avoid mixing
    // SYP + USD. Returns one row per (customer, currency); UI can decide ordering.
    const topCustomers = await this.db
      .select({
        partyId: invoices.partyId,
        revenue: sql<number>`SUM(${invoices.total})`,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          base,
          eq(invoices.type, "sale"),
          eq(invoices.partyType, "customer"),
          gte(invoices.date, monthStart),
          eq(invoices.status, "active"),
        ),
      )
      .groupBy(invoices.partyId, invoices.currency)
      .orderBy(desc(sql`SUM(${invoices.total})`))
      .limit(10);

    const customerIds = topCustomers.map((r) => r.partyId);
    const customerNames =
      customerIds.length > 0
        ? await this.db
            .select({ id: parties.id, name: parties.name })
            .from(parties)
            .where(and(eq(parties.tenantId, ctx.tenantId), inArray(parties.id, customerIds)))
        : [];

    // Fix H-7: `revenue` used to be summed with groupBy(fabricId) only —
    // a fabric sold in both SYP and USD had those two revenue figures
    // silently added together. kgSold is a physical quantity (not money)
    // so it is safe to sum across currencies; revenue is not, so it is
    // grouped by (fabricId, currency) and kept as a per-currency breakdown.
    const topFabricRows = await this.db
      .select({
        fabricId: invoiceLines.fabricId,
        currency: invoices.currency,
        kgSold: sql<number>`SUM(${invoiceLines.quantityKg})`,
        revenue: sql<number>`SUM(GREATEST(0, ${invoiceLines.quantityKg} * ${invoiceLines.pricePerKg} - ${invoiceLines.discountAmount}))`,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          eq(invoices.tenantId, ctx.tenantId),
          eq(invoices.type, "sale"),
          eq(invoices.status, "active"),
        ),
      )
      .groupBy(invoiceLines.fabricId, invoices.currency);

    const topFabricAgg = new Map<
      string,
      { fabricId: string; kgSold: number; revenueByCurrency: Record<string, number> }
    >();
    for (const r of topFabricRows) {
      const agg = topFabricAgg.get(r.fabricId) ?? {
        fabricId: r.fabricId,
        kgSold: 0,
        revenueByCurrency: {},
      };
      agg.kgSold += Number(r.kgSold);
      agg.revenueByCurrency[r.currency] = (agg.revenueByCurrency[r.currency] ?? 0) + Number(r.revenue);
      topFabricAgg.set(r.fabricId, agg);
    }
    const topFabricLines = Array.from(topFabricAgg.values())
      .sort((a, b) => b.kgSold - a.kgSold)
      .slice(0, 5);

    const fabricIds = topFabricLines.map((r) => r.fabricId);
    const fabricNames =
      fabricIds.length > 0
        ? await this.db
            .select({ id: fabrics.id, name: fabrics.name })
            .from(fabrics)
            .where(and(eq(fabrics.tenantId, ctx.tenantId), inArray(fabrics.id, fabricIds)))
        : [];

    const [todayMovements] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(manualMovements)
      .where(and(eq(manualMovements.tenantId, ctx.tenantId), eq(manualMovements.date, today)));
    const [dayLock] = await this.db
      .select()
      .from(dayCloses)
      .where(and(eq(dayCloses.tenantId, ctx.tenantId), eq(dayCloses.date, today)))
      .limit(1);

    // Fix H-7 (forensic audit 2026-08-15): this used to aggregate receipts
    // and payments with NO groupBy(currency) at all, silently summing SYP,
    // USD, and EUR vouchers into one meaningless number. Group by currency
    // like every other fixed aggregate in this file (weekSales, monthSales,
    // topCustomers, unpaidInvoices) and let the caller decide how to
    // display the breakdown — never fold currencies together server-side.
    const voucherStatsRows = await this.db
      .select({
        currency: vouchers.currency,
        receipts: sql<number>`COALESCE(SUM(CASE WHEN ${vouchers.kind} = 'receipt' THEN ${vouchers.amount} ELSE 0 END), 0)`,
        payments: sql<number>`COALESCE(SUM(CASE WHEN ${vouchers.kind} = 'payment' THEN ${vouchers.amount} ELSE 0 END), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, ctx.tenantId),
          gte(vouchers.date, monthStart),
          eq(vouchers.status, "active"),
        ),
      )
      .groupBy(vouchers.currency);
    const voucherStatsByCurrency: Record<string, { receipts: number; payments: number; count: number }> = {};
    let voucherStatsCount = 0;
    for (const row of voucherStatsRows) {
      voucherStatsByCurrency[row.currency] = {
        receipts: Number(row.receipts),
        payments: Number(row.payments),
        count: Number(row.count),
      };
      voucherStatsCount += Number(row.count);
    }

    const [unread] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.isRead, false)));

    const recentActivity = await this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, ctx.tenantId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10);

    // ── Active rolls (in-stock) ──────────────────────────────────────
    const [rollStats] = await this.db
      .select({
        total: sql<number>`COUNT(*) FILTER (WHERE ${rolls.status} = 'in_stock')`,
        colors: sql<number>`COUNT(DISTINCT ${rolls.colorId}) FILTER (WHERE ${rolls.status} = 'in_stock')`,
      })
      .from(rolls)
      .where(eq(rolls.tenantId, ctx.tenantId));
    const [fabricTypesRow] = await this.db
      .select({
        count: sql<number>`COUNT(DISTINCT ${colors.fabricId}) FILTER (WHERE ${rolls.status} = 'in_stock')`,
      })
      .from(rolls)
      .innerJoin(colors, eq(colors.id, rolls.colorId))
      .where(eq(rolls.tenantId, ctx.tenantId));

    // ── Total available inventory (sum of all remaining kg) ─────────
    const [invKgRow] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${rolls.remainingKg}), 0)` })
      .from(rolls)
      .where(eq(rolls.tenantId, ctx.tenantId));

    // ── Active customers today (distinct customer parties) ──────────
    const [activeCustomersTodayRow] = await this.db
      .select({ count: sql<number>`COUNT(DISTINCT ${invoices.partyId})` })
      .from(invoices)
      .where(
        and(base, eq(invoices.date, today), eq(invoices.status, "active"), eq(invoices.partyType, "customer")),
      );

    // ── Low-stock / out-of-stock rolls (real roll-level counts) ─────
    const [lowRollStats] = await this.db
      .select({
        low: sql<number>`COUNT(*) FILTER (WHERE ${rolls.remainingKg} > 0 AND ${rolls.remainingKg} <= ${fabrics.minStockKg})`,
        out: sql<number>`COUNT(*) FILTER (WHERE ${rolls.remainingKg} <= 0)`,
      })
      .from(rolls)
      .innerJoin(colors, eq(colors.id, rolls.colorId))
      .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
      .where(eq(rolls.tenantId, ctx.tenantId));

    // ── Today / yesterday profit (revenue − COGS) ───────────────────
    // Cost basis: current roll purchase price (price_per_kg) at sale time.
    const saleBase = and(base, eq(invoices.type, "sale"), eq(invoices.status, "active"));
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // Fix H-7: revStats/cogsStats had no groupBy(currency) at all — a USD
    // sale and a SYP sale on the same day were summed into one "profitToday"
    // number with no currency attached. Group both by currency and compute
    // profit per currency; never combine.
    const revStatsRows = await this.db
      .select({
        currency: invoices.currency,
        today: sql<number>`COALESCE(SUM(${invoices.total}) FILTER (WHERE ${invoices.date} = ${today}), 0)`,
        yesterday: sql<number>`COALESCE(SUM(${invoices.total}) FILTER (WHERE ${invoices.date} = ${yesterday}), 0)`,
      })
      .from(invoices)
      .where(and(saleBase, gte(invoices.date, yesterday)))
      .groupBy(invoices.currency);
    const cogsStatsRows = await this.db
      .select({
        currency: invoices.currency,
        // I6 fix: round COGS per line so the dashboard profit is an exact integer
        // that matches the journaled COGS (ledger entries are integer bigint).
        today: sql<number>`COALESCE(SUM(ROUND(${invoiceLines.quantityKg} * ${rolls.pricePerKg})) FILTER (WHERE ${invoices.date} = ${today}), 0)`,
        yesterday: sql<number>`COALESCE(SUM(ROUND(${invoiceLines.quantityKg} * ${rolls.pricePerKg})) FILTER (WHERE ${invoices.date} = ${yesterday}), 0)`,
      })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .innerJoin(rolls, eq(rolls.id, invoiceLines.rollId))
      .where(and(saleBase, gte(invoices.date, yesterday)))
      .groupBy(invoices.currency);

    const cogsByCurrency = new Map(cogsStatsRows.map((r) => [r.currency, r]));
    const profitByCurrency: Record<string, { today: number; yesterday: number; revenueToday: number }> = {};
    for (const rev of revStatsRows) {
      const cogs = cogsByCurrency.get(rev.currency);
      profitByCurrency[rev.currency] = {
        today: Number(rev.today) - Number(cogs?.today ?? 0),
        yesterday: Number(rev.yesterday) - Number(cogs?.yesterday ?? 0),
        revenueToday: Number(rev.today),
      };
    }

    // ── Unpaid sale invoices (total − active receipts per invoice) ──
    // Keep every currency's remaining amount separate — never fold SYP/USD/EUR
    // into one meaningless totalDue. The aggregate `count` is the number of
    // unpaid invoices across currencies.
    const unpaidSub = this.db
      .select({
        id: invoices.id,
        currency: invoices.currency,
        remaining: sql<number>`${invoices.total} - COALESCE(SUM(${vouchers.amount}), 0)`.as("remaining"),
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
      .where(and(base, eq(invoices.type, "sale"), eq(invoices.status, "active")))
      .groupBy(invoices.id, invoices.total, invoices.currency)
      .as("unpaid_sub");
    const unpaidRows = await this.db
      .select({
        currency: unpaidSub.currency,
        count: sql<number>`COUNT(*)`,
        totalDue: sql<number>`COALESCE(SUM(${unpaidSub.remaining}), 0)`,
      })
      .from(unpaidSub)
      .where(sql`${unpaidSub.remaining} > 0`)
      .groupBy(unpaidSub.currency);

    const unpaidByCurrency: Record<string, { count: number; totalDue: number }> = {};
    let unpaidTotalCount = 0;
    for (const row of unpaidRows) {
      unpaidByCurrency[row.currency] = {
        count: Number(row.count),
        totalDue: Number(row.totalDue),
      };
      unpaidTotalCount += Number(row.count);
    }

    // ── Sales trend (per-day series for 7/14/30) ────────────────────
    // Fix H-7: groupBy(invoices.date) alone mixed every currency's sales
    // into one "value" per day bucket. Group by date AND currency, and
    // expose a per-currency breakdown per day instead of a single number.
    const trendRows = await this.db
      .select({
        date: invoices.date,
        currency: invoices.currency,
        total: sql<number>`COALESCE(SUM(${invoices.total}), 0)`,
      })
      .from(invoices)
      .where(and(saleBase, gte(invoices.date, monthStart)))
      .groupBy(invoices.date, invoices.currency)
      .orderBy(invoices.date);
    const trendByDate = new Map<string, Record<string, number>>();
    for (const r of trendRows) {
      const byCurrency = trendByDate.get(r.date) ?? {};
      byCurrency[r.currency] = Number(r.total);
      trendByDate.set(r.date, byCurrency);
    }
    const buildTrend = (days: number) => {
      const out: Array<{ label: string; byCurrency: Record<string, number> }> = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        out.push({ label: d, byCurrency: trendByDate.get(d) ?? {} });
      }
      return out;
    };

    // ── Low-stock inventory alerts ──────────────────────────────────
    const lowStockAlerts = await this.db
      .select({
        rollNo: rolls.rollNo,
        remainingKg: rolls.remainingKg,
        colorName: colors.name,
        colorCode: colors.code,
        fabricName: fabrics.name,
      })
      .from(rolls)
      .innerJoin(colors, eq(colors.id, rolls.colorId))
      .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
      .where(
        and(
          eq(rolls.tenantId, ctx.tenantId),
          sql`${rolls.remainingKg} <= ${fabrics.minStockKg}`,
        ),
      )
      .orderBy(desc(rolls.remainingKg))
      .limit(20);

    // ── Store identity (company profile — real source) ──────────────
    const [company] = await this.db
      .select({ name: companyProfiles.name, city: companyProfiles.city })
      .from(companyProfiles)
      .where(eq(companyProfiles.tenantId, ctx.tenantId))
      .limit(1);

    // ── Cashbox balance (real: opening + movements in − out) ────────
    // Mirrors GET /cashbox/balance/:date — same formula.
    const [cashSession] = await this.db
      .select()
      .from(cashboxSessions)
      .where(eq(cashboxSessions.tenantId, ctx.tenantId))
      .limit(1);
    let cashBalance = 0;
    if (cashSession) {
      const from = cashSession.openingDate;
      const currency = cashSession.currency;
      const [ledgerCash] = await this.db
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
            sql`${ledgerEntries.date} <= ${today}`,
          ),
        );
      const manualRows = await this.db
        .select({
          direction: manualMovements.direction,
          amount: manualMovements.amount,
          date: manualMovements.date,
          currency: manualMovements.currency,
        })
        .from(manualMovements)
        .where(eq(manualMovements.tenantId, ctx.tenantId));
      let mIn = 0;
      let mOut = 0;
      for (const m of manualRows) {
        if (m.currency !== currency || m.date > today || m.date < from) continue;
        if (m.direction === "in") mIn += m.amount;
        else mOut += m.amount;
      }
      cashBalance =
        cashSession.openingBalance +
        Number(ledgerCash?.amountIn ?? 0) +
        mIn -
        Number(ledgerCash?.amountOut ?? 0) -
        mOut;
    }

    // ── Today's invoice count (all types: entry + sale) ─────────────
    const [todayInvoicesRow] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(invoices)
      .where(and(base, eq(invoices.date, today), eq(invoices.status, "active")));

    // ── Recent transactions (last 10 real operations, newest first) ─
    const recentInvoices = await this.db
      .select({
        id: invoices.id,
        number: invoices.number,
        type: invoices.type,
        total: invoices.total,
        currency: invoices.currency,
        createdAt: invoices.createdAt,
        partyId: invoices.partyId,
        partyType: invoices.partyType,
        partyName: parties.name,
      })
      .from(invoices)
      .innerJoin(parties, eq(parties.id, invoices.partyId))
      .where(
        and(
          base,
          eq(invoices.status, "active"),
          inArray(invoices.type, ["sale", "entry"]),
        ),
      )
      .orderBy(desc(invoices.createdAt))
      .limit(10);

    const recentVouchers = await this.db
      .select({
        id: vouchers.id,
        number: vouchers.number,
        kind: vouchers.kind,
        amount: vouchers.amount,
        currency: vouchers.currency,
        createdAt: vouchers.createdAt,
        partyId: vouchers.partyId,
        partyName: parties.name,
        invoiceNumber: invoices.number,
      })
      .from(vouchers)
      .innerJoin(parties, eq(parties.id, vouchers.partyId))
      .leftJoin(invoices, eq(invoices.id, vouchers.invoiceId))
      .where(
        and(
          eq(vouchers.tenantId, ctx.tenantId),
          eq(vouchers.status, "active"),
          eq(vouchers.kind, "receipt"),
        ),
      )
      .orderBy(desc(vouchers.createdAt))
      .limit(10);

    const recentReturns = await this.db
      .select({
        id: returns.id,
        number: returns.number,
        kind: returns.kind,
        currency: returns.currency,
        createdAt: returns.createdAt,
        partyId: returns.partyId,
        partyName: parties.name,
        originalInvoice: invoices.number,
        amount: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
      })
      .from(returns)
      .innerJoin(parties, eq(parties.id, returns.partyId))
      .leftJoin(returnLines, eq(returnLines.returnId, returns.id))
      .leftJoin(invoices, eq(invoices.id, returns.originalInvoiceId))
      .where(and(eq(returns.tenantId, ctx.tenantId), eq(returns.status, "active")))
      .groupBy(
        returns.id,
        returns.number,
        returns.kind,
        returns.currency,
        returns.createdAt,
        returns.partyId,
        parties.name,
        invoices.number,
      )
      .orderBy(desc(returns.createdAt))
      .limit(10);

    const recentTransactions = [
      ...recentInvoices.map((r) => ({
        type: (r.type === "entry" ? "entry" : "sale") as "sale" | "entry",
        id: r.id,
        invoiceNo: r.number,
        amount: Number(r.total),
        currency: r.currency,
        customer: r.partyType === "customer" ? r.partyName : undefined,
        supplier: r.partyType === "supplier" ? r.partyName : undefined,
        party: r.partyName,
        detail: r.type === "entry" ? "فاتورة دخول" : "فاتورة مبيع",
        time: r.createdAt.toISOString(),
      })),
      ...recentVouchers.map((v) => ({
        type: "payment" as const,
        id: v.id,
        reference: v.invoiceNumber ?? v.number,
        amount: Number(v.amount),
        currency: v.currency,
        party: v.partyName,
        detail: v.invoiceNumber ? `تسديد على ${v.invoiceNumber}` : "سند قبض",
        time: v.createdAt.toISOString(),
      })),
      ...recentReturns.map((r) => ({
        type: "return" as const,
        id: r.id,
        reference: r.originalInvoice ?? r.number,
        amount: Number(r.amount),
        currency: r.currency,
        party: r.partyName,
        detail: `مرتجع ${r.kind === "entry" ? "دخول" : "مبيع"}`,
        time: r.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 10);

    return {
      store: {
        name: company?.name ?? "",
        city: company?.city ?? "",
      },
      todaySales: {
        // FIX 1.1: NEVER mix currencies. Callers must read byCurrency[SYP/USD/...]
        // separately. The legacy `total`/`count`/`currency` fields were removed
        // to prevent silent aggregation of SYP + USD into one meaningless number.
        byCurrency: todaySalesByCurrency,
      },
      todayInvoices: {
        count: Number(todayInvoicesRow?.count ?? 0),
      },
      recentTransactions,
      // FIX 1.1: per-currency breakdown for week/month sales.
      weekSales: { byCurrency: weekSalesByCurrency },
      monthSales: { byCurrency: monthSalesByCurrency },
      outstandingOrders: Number(outstanding?.count ?? 0),
      lowStockFabrics: lowStockCount,
      topCustomers: topCustomers.map((r) => ({
        partyId: r.partyId,
        name: customerNames.find((c) => c.id === r.partyId)?.name ?? r.partyId,
        revenue: Number(r.revenue),
        currency: r.currency,
      })),
      topFabrics: topFabricLines.map((r) => ({
        fabricId: r.fabricId,
        name: fabricNames.find((f) => f.id === r.fabricId)?.name ?? r.fabricId,
        kgSold: r.kgSold,
        // FIX H-7: per-currency breakdown — never a single blended number.
        revenueByCurrency: r.revenueByCurrency,
      })),
      lowStockRolls: {
        low: Number(lowRollStats?.low ?? 0),
        outOfStock: Number(lowRollStats?.out ?? 0),
      },
      // FIX H-7: `syp` used to be a single number that actually summed
      // profit across every currency, mislabeled as if it were SYP-only.
      // byCurrency reports each currency's own profitToday/marginPercent/
      // trend independently — never combined.
      todayProfit: {
        byCurrency: Object.fromEntries(
          Object.entries(profitByCurrency).map(([currency, p]) => [
            currency,
            {
              today: p.today,
              marginPercent: p.revenueToday > 0 ? Math.round((p.today / p.revenueToday) * 100) : 0,
              trend: p.today >= p.yesterday ? ("up" as const) : ("down" as const),
            },
          ]),
        ),
      },
      activeRolls: {
        total: Number(rollStats?.total ?? 0),
        fabricTypes: Number(fabricTypesRow?.count ?? 0),
        colors: Number(rollStats?.colors ?? 0),
      },
      totalInventoryKg: Number(invKgRow?.total ?? 0),
      activeTodayCustomers: Number(activeCustomersTodayRow?.count ?? 0),
      unpaidInvoices: {
        count: unpaidTotalCount,
        byCurrency: unpaidByCurrency,
      },
      salesTrend: {
        "7": buildTrend(7),
        "14": buildTrend(14),
        "30": buildTrend(30),
      },
      alerts: lowStockAlerts.map((r) => ({
        category: "inventory" as const,
        level: Number(r.remainingKg) <= 0 ? ("out" as const) : ("low" as const),
        fabric: r.fabricName,
        color: r.colorName,
        colorCode: r.colorCode ?? undefined,
        rollNo: r.rollNo,
        remaining: `${r.remainingKg} كغ`,
      })),
      cashbox: {
        balance: cashBalance,
        todayMovementCount: Number(todayMovements?.count ?? 0),
        isLocked: !!dayLock,
      },
      // FIX H-7: byCurrency breakdown instead of one blended
      // receiptsThisMonth/paymentsThisMonth number.
      vouchers: {
        byCurrency: voucherStatsByCurrency,
        count: voucherStatsCount,
      },
      unreadNotifications: Number(unread?.count ?? 0),
      recentActivity: recentActivity.map((a) => ({
        module: a.module,
        action: a.action,
        detail: a.detail ?? "",
        timestamp: a.createdAt.toISOString(),
      })),
    };
  }
}
