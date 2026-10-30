// Reports for the phone (FR-28): the same repository calls as the desktop /reports and /profit routes, so the figures are
// the desktop's. Every money figure stays per currency; currencies are never added together.
import type { Phone } from "./phone";
import * as profitUc from "@backend/application/use-cases/profit/profitUseCases";
import type { ProfitSummaryByCurrency } from "@backend/domain/entities/Profit";

export type ByCurrency = Record<string, number>;

export type ReportPeriod = "all" | "month" | "year" | "last30";

export const PERIOD_LABEL: Record<ReportPeriod, string> = {
  all: "كل الفترات",
  month: "هذا الشهر",
  last30: "آخر 30 يوماً",
  year: "هذه السنة",
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** First day (YYYY-MM-DD) of a period, or null for all time. `today` is injectable for tests. */
export function periodFrom(period: ReportPeriod, today = new Date()): string | null {
  if (period === "all") return null;
  if (period === "month") return iso(new Date(today.getFullYear(), today.getMonth(), 1));
  if (period === "year") return iso(new Date(today.getFullYear(), 0, 1));
  const d = new Date(today);
  d.setDate(d.getDate() - 30);
  return iso(d);
}

export interface ReportAmount {
  amount: number;
  currency: string;
}

export interface ReportLine {
  id: string;
  title: string;
  subtitle: string;
  amounts: ReportAmount[];
}

export interface ReportFigure {
  label: string;
  amounts: ReportAmount[];
  plain?: string;
}

export interface ReportPage {
  slug: string;
  title: string;
  figures: ReportFigure[];
  lines: ReportLine[];
  total: number;
}

export const REPORT_LIST: { slug: string; title: string }[] = [
  { slug: "net-sales", title: "المبيعات" },
  { slug: "purchases", title: "المشتريات" },
  { slug: "sales-returns", title: "مرتجعات المبيعات" },
  { slug: "expenses", title: "المصروفات" },
  { slug: "ledger", title: "دفتر القيود" },
  { slug: "inventory-value", title: "قيمة المخزون" },
  { slug: "top-fabrics", title: "أكثر الأقمشة مبيعاً" },
  { slug: "top-customers", title: "أفضل العملاء" },
];

export function toAmounts(map: ByCurrency | undefined): ReportAmount[] {
  return Object.entries(map ?? {})
    .map(([currency, amount]) => ({ currency, amount: Number(amount) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface SummaryReport {
  figures: ReportFigure[];
  topFabrics: ReportLine[];
  topCustomers: ReportLine[];
}

/** The overview (desktop /reports/summary). */
export async function loadSummary(phone: Phone, from: string | null): Promise<SummaryReport> {
  const t = phone.identity.tenantId;
  const r = phone.repos.reportsRepo;
  const [sales, purchases, salesReturns, entryReturns, expenses, inventory, fabrics, customers] =
    await Promise.all([
      r.invoiceTotalsByCurrency(t, "sale", from),
      r.invoiceTotalsByCurrency(t, "entry", from),
      r.returnTotalsByCurrency(t, "sale", from),
      r.returnTotalsByCurrency(t, "entry", from),
      r.expenseTotalsByCurrency(t, from),
      r.inventoryValue(t),
      r.topFabrics(t, from, 5),
      r.topCustomers(t, from, 5, "usdFirst"),
    ]);
  return {
    figures: [
      { label: "المبيعات", amounts: toAmounts(sales.total) },
      { label: "المشتريات", amounts: toAmounts(purchases.total) },
      { label: "مرتجعات المبيعات", amounts: toAmounts(salesReturns.total) },
      { label: "مرتجعات المشتريات", amounts: toAmounts(entryReturns.total) },
      { label: "المصروفات", amounts: toAmounts(expenses.total) },
      { label: "قيمة المخزون", amounts: toAmounts(inventory.value) },
      {
        label: "المخزون",
        amounts: [],
        plain: `${inventory.totalKg.toFixed(2)} كغ · ${inventory.rollCount} لفة`,
      },
    ],
    topFabrics: fabrics.map((f) => ({
      id: f.fabricId,
      title: f.name,
      subtitle: `${num(f.qty).toFixed(2)} كغ`,
      amounts: toAmounts(f.revenueByCurrency),
    })),
    topCustomers: customers.map((c) => ({
      id: c.partyId,
      title: c.name,
      subtitle: "",
      amounts: toAmounts(c.revenueByCurrency),
    })),
  };
}

const PAGE = 100;

/** One detail report (desktop /reports/detail/:slug): the full-period figures plus the first page of rows. */
export async function loadDetail(
  phone: Phone,
  slug: string,
  from: string | null,
  page = 0,
): Promise<ReportPage | null> {
  const t = phone.identity.tenantId;
  const r = phone.repos.reportsRepo;
  const title = REPORT_LIST.find((x) => x.slug === slug)?.title ?? slug;
  switch (slug) {
    case "net-sales":
    case "purchases": {
      const totals = await r.invoiceTotalsByCurrency(
        t,
        slug === "net-sales" ? "sale" : "entry",
        from,
      );
      const paged = await r.pagedRows(t, slug, from, { page, limit: PAGE });
      return {
        slug,
        title,
        total: paged?.total ?? 0,
        figures: [
          { label: "الإجمالي", amounts: toAmounts(totals.total) },
          { label: "المدفوع", amounts: toAmounts(totals.paid) },
          { label: "المتبقي", amounts: toAmounts(totals.remaining) },
          { label: "عدد الفواتير", amounts: [], plain: String(totals.count) },
        ],
        lines: (paged?.rows ?? []).map((x) => ({
          id: str(x.id),
          title: `${str(x.number)} · ${str(x.partyName)}`,
          subtitle: `${str(x.date)} · مدفوع ${num(x.paid)} · متبقٍ ${num(x.remaining)}`,
          amounts: [{ amount: num(x.total), currency: str(x.currency) }],
        })),
      };
    }
    case "sales-returns": {
      const totals = await r.returnTotalsByCurrency(t, "sale", from);
      const paged = await r.pagedRows(t, slug, from, { page, limit: PAGE });
      return {
        slug,
        title,
        total: paged?.total ?? 0,
        figures: [
          { label: "الإجمالي", amounts: toAmounts(totals.total) },
          { label: "العدد", amounts: [], plain: String(totals.count) },
        ],
        lines: (paged?.rows ?? []).map((x) => ({
          id: str(x.id),
          title: `${str(x.number)} · ${str(x.partyName)}`,
          subtitle: str(x.date),
          amounts: [{ amount: num(x.amount), currency: str(x.currency) }],
        })),
      };
    }
    case "expenses": {
      const totals = await r.expenseTotalsByCurrency(t, from);
      const paged = await r.pagedRows(t, slug, from, { page, limit: PAGE });
      return {
        slug,
        title,
        total: paged?.total ?? 0,
        figures: [
          { label: "الإجمالي", amounts: toAmounts(totals.total) },
          { label: "العدد", amounts: [], plain: String(totals.count) },
        ],
        lines: (paged?.rows ?? []).map((x) => ({
          id: str(x.id),
          title: `${str(x.category)} · ${str(x.description)}`,
          subtitle: str(x.date),
          amounts: [{ amount: num(x.amount), currency: str(x.currency) }],
        })),
      };
    }
    case "ledger": {
      const totals = await r.ledgerTotalsByCurrency(t, from);
      const paged = await r.pagedRows(t, slug, from, { page, limit: PAGE });
      return {
        slug,
        title,
        total: paged?.total ?? 0,
        figures: [
          { label: "مدين", amounts: toAmounts(totals.debit) },
          { label: "دائن", amounts: toAmounts(totals.credit) },
          { label: "عدد القيود", amounts: [], plain: String(totals.count) },
        ],
        lines: (paged?.rows ?? []).map((x) => ({
          id: str(x.id),
          title: `${str(x.referenceNumber)} · ${str(x.description)}`,
          subtitle: `${str(x.date)} · مدين ${num(x.debit)} · دائن ${num(x.credit)}`,
          amounts: [{ amount: num(x.debit) - num(x.credit), currency: str(x.currency) }],
        })),
      };
    }
    case "inventory-value": {
      const byFabric = await r.inventoryByFabric(t);
      const sum: ByCurrency = {};
      for (const f of byFabric) {
        for (const [c, v] of Object.entries(f.value)) sum[c] = (sum[c] ?? 0) + Number(v);
      }
      return {
        slug,
        title,
        total: byFabric.length,
        figures: [{ label: "إجمالي القيمة", amounts: toAmounts(sum) }],
        lines: byFabric.map((f) => ({
          id: f.fabricId,
          title: f.name,
          subtitle: `${num(f.kg).toFixed(2)} كغ · ${f.rolls} لفة`,
          amounts: toAmounts(f.value),
        })),
      };
    }
    case "top-fabrics": {
      const top = await r.topFabrics(t, from, 10);
      return {
        slug,
        title,
        total: top.length,
        figures: [],
        lines: top.map((f) => ({
          id: f.fabricId,
          title: f.name,
          subtitle: `${num(f.qty).toFixed(2)} كغ`,
          amounts: toAmounts(f.revenueByCurrency),
        })),
      };
    }
    case "top-customers": {
      const top = await r.topCustomers(t, from, 10, "syp");
      return {
        slug,
        title,
        total: top.length,
        figures: [],
        lines: top.map((c) => ({
          id: c.partyId,
          title: c.name,
          subtitle: "",
          amounts: toAmounts(c.revenueByCurrency),
        })),
      };
    }
    default:
      return null;
  }
}

export interface PartyBalanceLine {
  partyId: string;
  name: string;
  code: string;
  currency: string;
  remaining: number;
}

/** Balances per party and currency (desktop /reports/party-balances). Parties with nothing owed are dropped. */
export async function loadPartyBalances(
  phone: Phone,
  kind: "customer" | "supplier",
): Promise<PartyBalanceLine[]> {
  const rows = await phone.repos.reportsRepo.partyBalances(phone.identity.tenantId, kind);
  return rows
    .map((x) => ({
      partyId: str(x.partyId),
      name: str(x.name),
      code: str(x.code),
      currency: str(x.currency || x.partyCurrency),
      remaining: num(x.remaining),
    }))
    .filter((x) => x.remaining !== 0);
}

export interface ProfitReport {
  byCurrency: ProfitSummaryByCurrency[];
  lines: ReportLine[];
}

/** Profit for a period: revenue = subtotal − discount, cost from the invoice line snapshot (use-case output). */
export async function loadProfit(
  phone: Phone,
  period: ReportPeriod,
  currency?: string,
): Promise<ProfitReport> {
  const query = {
    ...(periodFrom(period) ? { fromDate: periodFrom(period) as string } : {}),
    ...(currency ? { currency } : {}),
  };
  const ctx = phone.context();
  const summary = await profitUc.getProfitSummaryUseCase(phone.repos.profitRepo, query, ctx);
  if (!summary.ok) throw new Error(summary.error);
  const details = await profitUc.getProfitDetailsUseCase(phone.repos.profitRepo, query, ctx);
  if (!details.ok) throw new Error(details.error);
  return {
    byCurrency: summary.data.byCurrency,
    lines: details.data.invoiceLines.map((l) => ({
      id: l.invoiceId,
      title: `${l.number} · ${l.partyName}`,
      subtitle: `${l.date} · التكلفة ${l.cogs} · الهامش ${l.marginPercent}%`,
      amounts: [{ amount: l.grossProfit, currency: l.currency }],
    })),
  };
}

export const MENU: { slug: string; title: string }[] = [
  { slug: "summary", title: "نظرة عامة" },
  { slug: "profit", title: "الأرباح" },
  { slug: "party-customer", title: "أرصدة العملاء" },
  { slug: "party-supplier", title: "أرصدة الموردين" },
  ...REPORT_LIST,
];

/** Any report as one page (figures + lines), so a single screen renders them all. */
export async function loadReportPage(
  phone: Phone,
  slug: string,
  period: ReportPeriod,
): Promise<ReportPage | null> {
  const from = periodFrom(period);
  const title = MENU.find((m) => m.slug === slug)?.title ?? slug;
  if (slug === "summary") {
    const s = await loadSummary(phone, from);
    return {
      slug,
      title,
      figures: s.figures,
      lines: [
        ...s.topFabrics.map((l) => ({ ...l, subtitle: `أكثر الأقمشة · ${l.subtitle}` })),
        ...s.topCustomers.map((l) => ({ ...l, subtitle: "أفضل العملاء" })),
      ],
      total: s.topFabrics.length + s.topCustomers.length,
    };
  }
  if (slug === "party-customer" || slug === "party-supplier") {
    const kind = slug === "party-customer" ? "customer" : "supplier";
    const lines = await loadPartyBalances(phone, kind);
    return {
      slug,
      title,
      figures: [],
      total: lines.length,
      lines: lines.map((l) => ({
        id: `${l.partyId}-${l.currency}`,
        title: l.name,
        subtitle: l.code,
        amounts: [{ amount: l.remaining, currency: l.currency }],
      })),
    };
  }
  if (slug === "profit") {
    const p = await loadProfit(phone, period);
    const per = (label: string, pick: (c: ProfitSummaryByCurrency) => number): ReportFigure => ({
      label,
      amounts: p.byCurrency.map((c) => ({ currency: c.currency, amount: pick(c) })),
    });
    return {
      slug,
      title,
      total: p.lines.length,
      figures: [
        per("إيراد المبيعات", (c) => c.salesRevenue),
        per("تكلفة البضاعة", (c) => c.cogs),
        per("المصروفات", (c) => c.expenses),
        per("صافي الربح", (c) => c.netProfit),
      ],
      lines: p.lines,
    };
  }
  return loadDetail(phone, slug, from);
}
