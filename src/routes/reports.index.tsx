import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, type ComponentType } from "react";
import {
  Package,
  Users,
  FileText,
  ArrowLeftRight,
  X,
  Banknote,
  DollarSign,
  Euro,
} from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { useExpensesList } from "@/presentation/hooks/useExpenses";
import { useCashBalance } from "@/presentation/hooks/useCashbox";
import {
  useInventory,
  rolls,
  fabricById,
} from "@/presentation/hooks/useInventory";
import { suppliers, customers, useParties } from "@/presentation/hooks/useParties";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import {
  CURRENCIES,
  formatAmount,
  groupAmountsByCurrency,
  addCurrencyBreakdowns,
  type Currency,
} from "@/presentation/hooks/useCurrency";
import { formatMoney, formatNumber } from "@/shared/utils/formatNumber";
import { cn } from "@/lib/utils";
import { showSuccess } from "@/components/common/toast-helpers";
import { convertForSettlement } from "@erp/shared";

export const Route = createFileRoute("/reports/")({ component: ReportsPage });

const FULL = { limit: 1000, page: 0 };

type ConvertMode = {
  target: Currency;
  /** Units of non-USD per 1 USD (e.g. ل.س لكل دولار). */
  sypPerUsd: number;
  /** Units of EUR per 1 USD when EUR is involved. */
  eurPerUsd?: number;
};

const CURRENCY_META: Record<
  Currency,
  { Icon: ComponentType<{ className?: string }>; chip: string; accent: string }
> = {
  SYP: {
    Icon: Banknote,
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    accent: "border-emerald-500/35",
  },
  USD: {
    Icon: DollarSign,
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    accent: "border-sky-500/35",
  },
  EUR: {
    Icon: Euro,
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    accent: "border-violet-500/35",
  },
};

/**
 * Display-only conversion via USD anchor (same rule as vouchers).
 * Never mutates invoices / ledger / cashbox.
 */
function convertAmount(
  amount: number,
  from: Currency,
  target: Currency,
  mode: ConvertMode,
): number {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (from === target) return amount;

  const viaUsd = (amt: number, cur: Currency): number | null => {
    if (cur === "USD") return amt;
    if (cur === "SYP") return convertForSettlement(amt, "SYP", "USD", mode.sypPerUsd);
    if (cur === "EUR") {
      if (!(mode.eurPerUsd && mode.eurPerUsd > 0)) return null;
      return convertForSettlement(amt, "EUR", "USD", mode.eurPerUsd);
    }
    return null;
  };
  const fromUsd = (amtUsd: number, cur: Currency): number | null => {
    if (cur === "USD") return amtUsd;
    if (cur === "SYP") return convertForSettlement(amtUsd, "USD", "SYP", mode.sypPerUsd);
    if (cur === "EUR") {
      if (!(mode.eurPerUsd && mode.eurPerUsd > 0)) return null;
      return convertForSettlement(amtUsd, "USD", "EUR", mode.eurPerUsd);
    }
    return null;
  };

  const usd = viaUsd(amount, from);
  if (usd == null) return 0;
  return fromUsd(usd, target) ?? 0;
}

function convertBreakdown(
  byCurrency: Record<string, number>,
  target: Currency,
  mode: ConvertMode,
): number {
  let sum = 0;
  for (const [code, amt] of Object.entries(byCurrency)) {
    sum += convertAmount(amt, (code as Currency) || "SYP", target, mode);
  }
  return Math.round(sum * 100) / 100;
}

function pick(by: Record<string, number>, code: Currency): number {
  return by[code] ?? 0;
}

function ReportsPage() {
  useInventory();
  useParties();

  const { data: invoicesData } = useInvoicesList(FULL);
  const invoices = useMemo(() => invoicesData?.data ?? [], [invoicesData]);
  const { data: returnsData } = useReturnsList(FULL);
  const returns = useMemo(() => returnsData?.data ?? [], [returnsData]);
  const { data: expensesData } = useExpensesList(FULL);
  const expenses = useMemo(() => expensesData ?? [], [expensesData]);
  const { data: cashBalSYP = 0 } = useCashBalance(undefined, "SYP");
  const { data: cashBalUSD = 0 } = useCashBalance(undefined, "USD");
  const { data: cashBalEUR = 0 } = useCashBalance(undefined, "EUR");
  const cashByCurrency: Record<string, number> = {
    SYP: cashBalSYP as number,
    USD: cashBalUSD as number,
    EUR: cashBalEUR as number,
  };

  const [range, setRange] = useState<"7" | "30" | "90" | "all">("30");
  const [convertOpen, setConvertOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draftTarget, setDraftTarget] = useState<Currency>("USD");
  const [draftSypRate, setDraftSypRate] = useState<string>("");
  const [draftEurRate, setDraftEurRate] = useState<string>("");
  const [convertMode, setConvertMode] = useState<ConvertMode | null>(null);

  const activeInvoices = useMemo(
    () => invoices.filter((i) => i.status !== "cancelled"),
    [invoices],
  );
  const activeReturns = useMemo(() => returns.filter((r) => r.status !== "cancelled"), [returns]);
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

  const salesInvoices = activeInvoices.filter((i) => i.type === "sale" && inRange(i.date));
  const purchaseInvoices = activeInvoices.filter((i) => i.type === "entry" && inRange(i.date));
  const salesReturns = activeReturns.filter((r) => r.kind === "sale" && inRange(r.date));
  const entryReturns = activeReturns.filter((r) => r.kind === "entry" && inRange(r.date));
  const periodExpenses = activeExpenses.filter((e) => inRange(e.date));

  const returnAmountOf = (r: (typeof salesReturns)[number]) =>
    r.lines.reduce((sum, l) => sum + l.quantityKg * l.pricePerKg, 0);

  const totalSales = groupAmountsByCurrency(salesInvoices, invoiceTotal, (i) => i.currency);
  const totalPurchases = groupAmountsByCurrency(purchaseInvoices, invoiceTotal, (i) => i.currency);
  const totalSalesReturns = groupAmountsByCurrency(
    salesReturns,
    returnAmountOf,
    (r) => r.currency || "SYP",
  );
  const totalEntryReturns = groupAmountsByCurrency(
    entryReturns,
    returnAmountOf,
    (r) => r.currency || "SYP",
  );
  const netRevenue = addCurrencyBreakdowns(totalSales, totalSalesReturns, -1);
  const totalExpenses = groupAmountsByCurrency(
    periodExpenses,
    (e: { amount: number }) => e.amount,
    (e) => e.currency,
  );
  const receivables = groupAmountsByCurrency(
    customers,
    (c) => c.stats?.remaining ?? 0,
    (c) => c.currency ?? "SYP",
  );
  const payables = groupAmountsByCurrency(
    suppliers,
    (s) => s.stats?.remaining ?? 0,
    (s) => s.currency ?? "SYP",
  );
  const inventoryValue = groupAmountsByCurrency(
    rolls,
    (r) => r.remainingKg * r.pricePerKg,
    (r) => r.currency,
  );

  const totalKg = rolls.reduce((s, r) => s + r.remainingKg, 0);

  const topFabrics = useMemo(() => {
    const map = new Map<string, number>();
    salesInvoices.forEach((inv) => {
      inv.lines.forEach((l) => map.set(l.fabricId, (map.get(l.fabricId) ?? 0) + l.quantityKg));
    });
    return [...map.entries()]
      .map(([id, qty]) => ({ fabric: fabricById(id), qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }, [salesInvoices]);

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
      .sort((a, b) => {
        const score = (x: Record<string, number>) =>
          (x.USD ?? 0) * 1e9 + (x.SYP ?? 0) + (x.EUR ?? 0);
        return score(b.revenueByCurrency) - score(a.revenueByCurrency);
      })
      .slice(0, 5);
  }, [salesInvoices]);

  const hasEur =
    pick(netRevenue, "EUR") !== 0 ||
    pick(totalPurchases, "EUR") !== 0 ||
    pick(totalExpenses, "EUR") !== 0 ||
    pick(cashByCurrency, "EUR") !== 0 ||
    pick(inventoryValue, "EUR") !== 0;

  const draftRateOk = Number(draftSypRate) > 0 && (!hasEur || Number(draftEurRate) > 0);
  const targetLabel = CURRENCIES.find((c) => c.code === draftTarget)?.label ?? draftTarget;

  const metricsFor = (code: Currency) => ({
    netRevenue: pick(netRevenue, code),
    sales: pick(totalSales, code),
    salesReturns: pick(totalSalesReturns, code),
    purchases: pick(totalPurchases, code),
    entryReturns: pick(totalEntryReturns, code),
    expenses: pick(totalExpenses, code),
    cash: pick(cashByCurrency, code),
    receivables: pick(receivables, code),
    payables: pick(payables, code),
    inventory: pick(inventoryValue, code),
  });

  const convertedMetrics = convertMode
    ? {
        netRevenue: convertBreakdown(netRevenue, convertMode.target, convertMode),
        sales: convertBreakdown(totalSales, convertMode.target, convertMode),
        salesReturns: convertBreakdown(totalSalesReturns, convertMode.target, convertMode),
        purchases: convertBreakdown(totalPurchases, convertMode.target, convertMode),
        entryReturns: convertBreakdown(totalEntryReturns, convertMode.target, convertMode),
        expenses: convertBreakdown(totalExpenses, convertMode.target, convertMode),
        cash: convertBreakdown(cashByCurrency, convertMode.target, convertMode),
        receivables: convertBreakdown(receivables, convertMode.target, convertMode),
        payables: convertBreakdown(payables, convertMode.target, convertMode),
        inventory: convertBreakdown(inventoryValue, convertMode.target, convertMode),
      }
    : null;

  const applyConvert = () => {
    const mode: ConvertMode = {
      target: draftTarget,
      sypPerUsd: Number(draftSypRate),
      ...(hasEur ? { eurPerUsd: Number(draftEurRate) } : {}),
    };
    setConvertMode(mode);
    setConfirmOpen(false);
    setConvertOpen(false);
    showSuccess(
      `تم تفعيل العرض التحويلي إلى ${targetLabel} بسعر ${mode.sypPerUsd.toLocaleString("en-US")} ل.س/$ — للعرض فقط، دون تعديل القيود.`,
    );
  };

  return (
    <AppShell
      title="التقارير"
      subtitle="كل عملة مستقلة — بدون خلط. استخدم «تحويلي» لعرض موحّد بسعر صرف تختاره."
    >
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["7", "30", "90", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                range === r
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary hover:bg-primary/5",
              )}
            >
              {r === "all" ? "الكل" : `${r} يوم`}
            </button>
          ))}
        </div>

        <Button
          type="button"
          size="lg"
          onClick={() => setConvertOpen(true)}
          className={cn(
            "h-12 gap-2 rounded-xl px-6 text-base font-extrabold shadow-md",
            "bg-amber-500 text-amber-950 hover:bg-amber-400",
            "ring-2 ring-amber-300/60 ring-offset-2 ring-offset-background",
          )}
        >
          <ArrowLeftRight className="h-5 w-5" />
          تحويلي
        </Button>
      </div>

      {convertMode && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <div className="font-medium text-foreground">
            عرض تحويلي نشط →{" "}
            <span className="font-extrabold">
              {CURRENCIES.find((c) => c.code === convertMode.target)?.label}
            </span>
            <span className="mr-2 text-muted-foreground">
              (سعر {formatNumber(convertMode.sypPerUsd)} ل.س لكل $1 — للعرض فقط، ليس قيداً محاسبياً)
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => {
              setConvertMode(null);
              showSuccess("تم إلغاء العرض التحويلي — رجوع لفصل العملات.");
            }}
          >
            <X className="h-3.5 w-3.5" />
            إلغاء التحويلي
          </Button>
        </div>
      )}

      {/* Currency panels OR unified converted panel */}
      {convertMode && convertedMetrics ? (
        <CurrencyPanel
          code={convertMode.target}
          title={`ملخص موحّد (${CURRENCIES.find((c) => c.code === convertMode.target)?.label})`}
          metrics={convertedMetrics}
          highlight
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {CURRENCIES.map(({ code, label }) => (
            <CurrencyPanel key={code} code={code} title={label} metrics={metricsFor(code)} />
          ))}
        </div>
      )}

      {/* Physical / non-money */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <InfoCard icon={Package} label="كمية المخزون" value={`${formatMoney(totalKg)} كغ`} />
        <InfoCard icon={Package} label="عدد الصبغات" value={String(rolls.length)} />
        <InfoCard icon={Users} label="العملاء" value={String(customers.length)} />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <PageCard title="أعلى الأقمشة مبيعاً (كغ)">
          <div className="space-y-1.5 text-sm">
            {topFabrics.length === 0 && (
              <p className="text-muted-foreground">لا مبيعات في الفترة المحددة.</p>
            )}
            {topFabrics.map((f, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="truncate">{f.fabric?.name ?? "—"}</span>
                <span className="shrink-0 tabular-nums font-semibold">
                  {formatNumber(Math.round(f.qty))} كغ
                </span>
              </div>
            ))}
          </div>
        </PageCard>
        <PageCard title="أعلى العملاء">
          <div className="space-y-2 text-sm">
            {topCustomers.length === 0 && (
              <p className="text-muted-foreground">لا مبيعات في الفترة المحددة.</p>
            )}
            {topCustomers.map((c, i) => (
              <div key={i} className="flex items-start justify-between gap-3">
                <span className="truncate font-medium">{c.customer?.name ?? "—"}</span>
                <PerCurrencyAmounts by={c.revenueByCurrency} convertMode={convertMode} />
              </div>
            ))}
          </div>
        </PageCard>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
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
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-foreground transition hover:border-primary/50 hover:bg-primary/5"
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            {label}
          </Link>
        ))}
      </div>

      {/* Setup dialog */}
      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <ArrowLeftRight className="h-5 w-5 text-amber-600" />
              تحويلي — عرض موحّد
            </DialogTitle>
            <DialogDescription className="text-start leading-relaxed">
              يعرض أرقام التقارير بعملة واحدة تختارها حسب سعر الصرف الذي تدخله.{" "}
              <strong className="text-foreground">لا يغيّر الفواتير ولا الصندوق ولا القيود</strong>
              — للفهم والمقارنة فقط.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>العملة المعروضة</Label>
              <Select
                value={draftTarget}
                onValueChange={(v) => setDraftTarget(v as Currency)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label} ({c.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>سعر الدولار بالليرة (كم ل.س = 1 $)</Label>
              <Input
                inputMode="decimal"
                dir="ltr"
                className="tabular-nums"
                placeholder="مثال: 1200"
                value={draftSypRate}
                onChange={(e) => setDraftSypRate(e.target.value.replace(/[^\d.]/g, ""))}
              />
            </div>

            {hasEur && (
              <div className="space-y-2">
                <Label>سعر اليورو مقابل الدولار (كم € = 1 $)</Label>
                <Input
                  inputMode="decimal"
                  dir="ltr"
                  className="tabular-nums"
                  placeholder="مثال: 0.92"
                  value={draftEurRate}
                  onChange={(e) => setDraftEurRate(e.target.value.replace(/[^\d.]/g, ""))}
                />
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setConvertOpen(false)}>
              إلغاء
            </Button>
            <Button
              type="button"
              disabled={!draftRateOk}
              className="bg-amber-500 font-bold text-amber-950 hover:bg-amber-400"
              onClick={() => setConfirmOpen(true)}
            >
              متابعة…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد العرض التحويلي</AlertDialogTitle>
            <AlertDialogDescription className="text-start text-sm leading-relaxed text-foreground/80">
              سيتم تحويل أرقام التقارير (سوري / دولار
              {hasEur ? " / يورو" : ""}) إلى{" "}
              <strong>{targetLabel}</strong> بسعر{" "}
              <strong dir="ltr">{Number(draftSypRate).toLocaleString("en-US")} ل.س/$</strong>
              {hasEur && draftEurRate ? (
                <>
                  {" "}
                  و<strong dir="ltr">{draftEurRate} €/$</strong>
                </>
              ) : null}
              .
              <br />
              <br />
              هذا <strong>عرض مؤقت للتقارير فقط</strong> — لن يُحوَّل الصندوق ولا تُعدَّل الفواتير.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>لا — إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-500 font-bold text-amber-950 hover:bg-amber-400"
              onClick={applyConvert}
            >
              نعم، اعرض موحّد
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

type Metrics = {
  netRevenue: number;
  sales: number;
  salesReturns: number;
  purchases: number;
  entryReturns: number;
  expenses: number;
  cash: number;
  receivables: number;
  payables: number;
  inventory: number;
};

function CurrencyPanel({
  code,
  title,
  metrics,
  highlight,
}: {
  code: Currency;
  title: string;
  metrics: Metrics;
  highlight?: boolean;
}) {
  const meta = CURRENCY_META[code];
  const Icon = meta.Icon;
  const rows: { label: string; value: number; tone?: string }[] = [
    { label: "صافي الإيرادات", value: metrics.netRevenue, tone: "text-primary" },
    { label: "المبيعات", value: metrics.sales, tone: "text-success" },
    { label: "مرتجعات المبيعات", value: metrics.salesReturns, tone: "text-destructive" },
    { label: "المشتريات", value: metrics.purchases },
    { label: "مرتجعات المشتريات", value: metrics.entryReturns, tone: "text-destructive" },
    { label: "المصاريف", value: metrics.expenses, tone: "text-destructive" },
    { label: "رصيد الصندوق", value: metrics.cash, tone: "text-sky-600 dark:text-sky-400" },
    { label: "ذمم العملاء", value: metrics.receivables, tone: "text-amber-700 dark:text-amber-400" },
    { label: "ذمم الموردين", value: metrics.payables, tone: "text-amber-700 dark:text-amber-400" },
    { label: "قيمة المخزون", value: metrics.inventory },
  ];

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-card shadow-soft",
        meta.accent,
        highlight && "ring-2 ring-amber-400/50",
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        <span className={cn("grid h-9 w-9 place-items-center rounded-xl", meta.chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <div className="text-sm font-bold text-foreground">{title}</div>
          <div className="text-[11px] font-semibold text-muted-foreground">{code}</div>
        </div>
      </header>
      <ul className="divide-y divide-border/60 px-4 py-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <span className="text-muted-foreground">{r.label}</span>
            <span className={cn("font-bold tabular-nums", r.tone ?? "text-foreground")} dir="ltr">
              {formatAmount(r.value, code)}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function PerCurrencyAmounts({
  by,
  convertMode,
}: {
  by: Record<string, number>;
  convertMode: ConvertMode | null;
}) {
  if (convertMode) {
    const n = convertBreakdown(by, convertMode.target, convertMode);
    return (
      <span className="shrink-0 text-xs font-bold tabular-nums" dir="ltr">
        {formatAmount(n, convertMode.target)}
      </span>
    );
  }
  const parts = CURRENCIES.map((c) => ({ code: c.code, n: by[c.code] ?? 0 })).filter(
    (x) => x.n !== 0,
  );
  if (parts.length === 0) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" dir="ltr">
        {formatAmount(0, "SYP")}
      </span>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      {parts.map((p) => (
        <span key={p.code} className="text-xs font-semibold tabular-nums" dir="ltr">
          {formatAmount(p.n, p.code)}
        </span>
      ))}
    </div>
  );
}

function InfoCard({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-soft">
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
