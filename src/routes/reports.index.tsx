import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  TrendingUp,
  Package,
  Wallet,
  Users,
  ArrowDownRight,
  ArrowUpRight,
  FileText,
} from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { AppShell } from "@/components/layout/AppShell";
import { DualCurrency } from "@/components/common/DualCurrency";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useReturnsList, returnAmount } from "@/presentation/hooks/useReturns";
import { useExpensesList } from "@/presentation/hooks/useExpenses";
import { useCashBalance } from "@/presentation/hooks/useCashbox";
import {
  useInventory,
  fabrics,
  colors,
  rolls,
  fabricById,
  formatSYP,
} from "@/presentation/hooks/useInventory";
import { suppliers, customers } from "@/presentation/hooks/useParties";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import {
  formatCurrencyBreakdown,
  groupAmountsByCurrency,
  addCurrencyBreakdowns,
} from "@/presentation/hooks/useCurrency";

export const Route = createFileRoute("/reports/")({ component: ReportsPage });

// Full dataset for accurate aggregation — reports must never be limited by
// the paginated (limit=20) default used by the invoices/summaries pages.
const FULL_INVOICES = { limit: 1000, page: 0 };
const FULL_VOUCHERS = { limit: 1000 };
const FULL_RETURNS = { limit: 1000 };
const FULL_EXPENSES = { limit: 1000 };

function ReportsPage() {
  useInventory();

  const { data: invoicesData } = useInvoicesList(FULL_INVOICES);
  const invoices = useMemo(() => invoicesData?.data ?? [], [invoicesData]);
  const { data: vouchersData } = useVouchersList(FULL_VOUCHERS);
  const vouchers = useMemo(() => vouchersData?.data ?? [], [vouchersData]);
  const paidByInvoice = (invoiceId: string) =>
    vouchers
      .filter((v) => v.status === "active" && v.invoiceId === invoiceId)
      .reduce((s, v) => s + v.amount, 0);
  const { data: returnsData } = useReturnsList(FULL_RETURNS);
  const returns = useMemo(() => returnsData?.data ?? [], [returnsData]);
  const { data: expensesData } = useExpensesList(FULL_EXPENSES);
  const expenses = useMemo(() => expensesData ?? [], [expensesData]);
  const { data: cashBalance = 0 } = useCashBalance();

  const [range, setRange] = useState<"7" | "30" | "90" | "all">("30");

  const activeInvoices = useMemo(
    () => invoices.filter((i) => i.status !== "cancelled"),
    [invoices],
  );
  const activeReturns = useMemo(
    () => returns.filter((r) => r.status !== "cancelled"),
    [returns],
  );
  const activeExpenses = useMemo(
    () => expenses.filter((e) => e.status !== "cancelled"),
    [expenses],
  );

  const cutoff = useMemo(() => {
    if (range === "all") return null;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(range, 10));
    return d.toISOString().slice(0, 10);
  }, [range]);

  const inRange = (date: string) => (cutoff ? date >= cutoff : true);

  // Fix BUG-06 / C-9 / C-10 (forensic audit 2026-08-15): every total below
  // used to convert non-SYP amounts through a hardcoded EXCHANGE_RATES
  // guess (toSYP) and sum the result into one blended number. Group by
  // currency instead — the true, unconverted amount for each currency —
  // and render via formatCurrencyBreakdown, which shows each currency's
  // own figure ("500,000 ل.س + 200 $") and never combines them.
  const salesInvoices = activeInvoices.filter(
    (i) => i.type === "sale" && inRange(i.date),
  );
  const totalSalesByCurrency = groupAmountsByCurrency(salesInvoices, invoiceTotal, (i) => i.currency);
  const totalReceivedByCurrency = groupAmountsByCurrency(
    salesInvoices,
    (i) => paidByInvoice(i.id),
    (i) => i.currency,
  );
  const receivablesByCurrency = groupAmountsByCurrency(
    salesInvoices,
    (i) => Math.max(0, invoiceTotal(i) - paidByInvoice(i.id)),
    (i) => i.currency,
  );

  const purchaseInvoices = activeInvoices.filter(
    (i) => i.type === "entry" && inRange(i.date),
  );
  const totalPurchasesByCurrency = groupAmountsByCurrency(purchaseInvoices, invoiceTotal, (i) => i.currency);
  const payablesByCurrency = groupAmountsByCurrency(
    purchaseInvoices,
    (i) => Math.max(0, invoiceTotal(i) - paidByInvoice(i.id)),
    (i) => i.currency,
  );

  const salesReturns = activeReturns.filter(
    (r) => r.kind === "sale" && inRange(r.date),
  );
  const entryReturns = activeReturns.filter(
    (r) => r.kind === "entry" && inRange(r.date),
  );
  const returnAmountOf = (r: (typeof salesReturns)[number]) =>
    r.lines.reduce((sum, l) => sum + l.quantityKg * l.pricePerKg, 0);
  const totalSalesReturnsByCurrency = groupAmountsByCurrency(
    salesReturns,
    returnAmountOf,
    (r) => r.currency || "SYP",
  );
  const totalEntryReturnsByCurrency = groupAmountsByCurrency(
    entryReturns,
    returnAmountOf,
    (r) => r.currency || "SYP",
  );

  const netRevenueByCurrency = addCurrencyBreakdowns(totalSalesByCurrency, totalSalesReturnsByCurrency, -1);

  const periodExpenses = activeExpenses.filter((e) => inRange(e.date));
  const totalExpensesByCurrency = groupAmountsByCurrency(
    periodExpenses,
    (e: { amount: number; currency: string }) => e.amount,
    (e) => e.currency,
  );

  const inventoryValueByCurrency = groupAmountsByCurrency(
    rolls,
    (r) => r.remainingKg * r.pricePerKg,
    (r) => r.currency,
  );
  const totalKg = rolls.reduce((s, r) => s + r.remainingKg, 0);
  const lowStockFabrics = fabrics.filter((f) => {
    const kg = colors
      .filter((c) => c.fabricId === f.id)
      .reduce(
        (sum, c) =>
          sum +
          rolls
            .filter((r) => r.colorId === c.id)
            .reduce((s, r) => s + r.remainingKg, 0),
        0,
      );
    return kg <= (f.minStockKg ?? 0);
  });

  // Fix BUG-06/C-9/C-10: ranked by physical kg sold (currency-agnostic —
  // safe to sum) instead of a toSYP-blended revenue number. The UI below
  // only ever displays `qty`, never revenue, for this card.
  const topFabrics = useMemo(() => {
    const map = new Map<string, { qty: number }>();
    salesInvoices.forEach((inv) => {
      inv.lines.forEach((l) => {
        const cur = map.get(l.fabricId) ?? { qty: 0 };
        cur.qty += l.quantityKg;
        map.set(l.fabricId, cur);
      });
    });
    return [...map.entries()]
      .map(([id, v]) => ({ fabric: fabricById(id), ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }, [salesInvoices]);

  // Fix BUG-06/C-9/C-10: revenue is now a per-currency breakdown, never a
  // toSYP-blended single number. Ranked by SYP revenue specifically
  // (documented, not blended) since a single sortable figure is needed
  // and there is no real FX rate to fairly compare SYP vs USD customers.
  const topCustomers = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    salesInvoices.forEach((inv) => {
      const prev = map.get(inv.partyId) ?? {};
      prev[inv.currency] = (prev[inv.currency] ?? 0) + invoiceTotal(inv);
      map.set(inv.partyId, prev);
    });
    return [...map.entries()]
      .map(([id, revenueByCurrency]) => ({
        customer: customers.find((c) => c.id === id),
        revenueByCurrency,
      }))
      .sort((a, b) => (b.revenueByCurrency.SYP ?? 0) - (a.revenueByCurrency.SYP ?? 0))
      .slice(0, 5);
  }, [salesInvoices]);

  return (
    <AppShell
      title="التقارير"
      subtitle="لوحة التقارير التحليلية والمالية مبنية على بيانات النظام الحية."
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          {(["7", "30", "90", "all"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                range === r
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary hover:bg-primary/5"
              }`}
            >
              {r === "all" ? "الكل" : `${r} يوم`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StatTile
          icon={TrendingUp}
          label="صافي الإيرادات"
          byCurrency={netRevenueByCurrency}
          tone="primary"
        />
        <StatTile
          icon={Wallet}
          label="الرصيد النقدي"
          value={cashBalance as number}
          tone="success"
        />
        <StatTile
          icon={Package}
          label="قيمة المخزون"
          byCurrency={inventoryValueByCurrency}
          tone="info"
        />
        <StatTile
          icon={Users}
          label="العملاء النشطون"
          value={customers.length}
          isCount
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PageCard title="ملخص المبيعات والمشتريات">
          <div className="space-y-2 text-sm">
            <DataRow
              icon={ArrowUpRight}
              label="إجمالي المبيعات"
              value={formatCurrencyBreakdown(totalSalesByCurrency)}
              tone="success"
            />
            <DataRow
              icon={ArrowDownRight}
              label="مرتجعات المبيعات"
              value={formatCurrencyBreakdown(totalSalesReturnsByCurrency)}
              tone="destructive"
            />
            <DataRow
              icon={ArrowDownRight}
              label="المستحقات (ذمم)"
              value={formatCurrencyBreakdown(receivablesByCurrency)}
              tone="warning"
            />
            <hr className="border-border" />
            <DataRow
              icon={ArrowDownRight}
              label="إجمالي المشتريات"
              value={formatCurrencyBreakdown(totalPurchasesByCurrency)}
              tone="info"
            />
            <DataRow
              icon={ArrowDownRight}
              label="مرتجعات المشتريات"
              value={formatCurrencyBreakdown(totalEntryReturnsByCurrency)}
              tone="destructive"
            />
            <DataRow
              icon={ArrowDownRight}
              label="الديون (الذمم)"
              value={formatCurrencyBreakdown(payablesByCurrency)}
              tone="warning"
            />
          </div>
        </PageCard>

        <PageCard title="المصاريف والصندوق">
          <div className="space-y-2 text-sm">
            <DataRow
              icon={ArrowDownRight}
              label="إجمالي المصاريف"
              value={formatCurrencyBreakdown(totalExpensesByCurrency)}
              tone="destructive"
            />
            <DataRow
              icon={Wallet}
              label="الرصيد النقدي الحالي"
              value={formatSYP(cashBalance as number)}
              tone="primary"
            />
          </div>
        </PageCard>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PageCard title="أعلى الأقمشة مبيعاً">
          <div className="space-y-1 text-sm">
            {topFabrics.map((f, i) => (
              <div key={i} className="flex justify-between">
                <span>{f.fabric?.name ?? ""}</span>
                <span className="tabular-nums">{Math.round(f.qty)} كغ</span>
              </div>
            ))}
          </div>
        </PageCard>

        <PageCard title="أعلى العملاء">
          <div className="space-y-1 text-sm">
            {topCustomers.map((c, i) => (
              <div key={i} className="flex justify-between">
                <span>{c.customer?.name ?? ""}</span>
                <span className="tabular-nums font-semibold">
                  {formatCurrencyBreakdown(c.revenueByCurrency)}
                </span>
              </div>
            ))}
          </div>
        </PageCard>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <InfoCard
          icon={Package}
          label="كمية المخزون"
          value={`${totalKg.toLocaleString("en-US")} كغ`}
        />
        <InfoCard
          icon={Package}
          label="عدد الصبغات"
          value={String(rolls.length)}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {(
          [
            ["net-sales", "المبيعات"],
            ["inventory-value", "المخزون"],
            ["receivables", "الأطراف"],
            ["ledger", "الأستاذ"],
            ["expenses", "المصاريف"],
            ["cashbox", "الصندوق"],
          ] as const
        ).map(([slug, label]) => (
          <Link
            key={slug}
            to="/reports/$slug"
            params={{ slug }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:border-primary/50 hover:bg-primary/5 transition"
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            {label}
          </Link>
        ))}
      </div>
    </AppShell>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  byCurrency,
  tone,
  isCount,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Single-currency or count value (unchanged usage). */
  value?: number;
  /**
   * Fix BUG-06/C-9/C-10: when the underlying figure can span multiple
   * currencies, pass a breakdown instead of a pre-blended `value` — this
   * renders each currency's own amount via formatCurrencyBreakdown,
   * never a toSYP-converted sum.
   */
  byCurrency?: Record<string, number>;
  tone?: string;
  isCount?: boolean;
}) {
  const bg =
    tone === "primary"
      ? "bg-primary/10 border-primary/40"
      : tone === "success"
        ? "bg-success/10 border-success/40"
        : tone === "info"
          ? "bg-blue-500/10 border-blue-500/40"
          : "bg-card border-border";
  return (
    <div className={`rounded-lg border ${bg} p-4`}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] font-semibold">{label}</span>
      </div>
      <div className="mt-1.5 text-lg font-bold tabular-nums">
        {isCount
          ? value
          : byCurrency
            ? formatCurrencyBreakdown(byCurrency)
            : formatSYP(value ?? 0)}
        {!isCount && !byCurrency && (
          <DualCurrency syp={value} className="text-[10px] mt-0.5" />
        )}
      </div>
    </div>
  );
}

function DataRow({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <Icon
          className={`h-3.5 w-3.5 ${tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : tone === "info" ? "text-blue-400" : "text-muted-foreground"}`}
        />
        <span>{label}</span>
      </div>
      <span className="tabular-nums font-semibold">{value}</span>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/15">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="font-bold tabular-nums">{value}</div>
      </div>
    </div>
  );
}
