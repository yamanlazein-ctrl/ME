import { useMemo } from "react";
import { Scale } from "lucide-react";
import { CASH_BOXES } from "@/components/cashbox/FinancialSummary";
import { useCashBalancesOn } from "@/presentation/hooks/useCashbox";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useProfitDetails, useProfitSummary } from "@/presentation/hooks/useProfit";
import { formatMoney } from "@/shared/utils/formatNumber";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { localToday } from "@/lib/localDate";
import { cn } from "@/lib/utils";
import type { ProfitQueryParams } from "@/contracts/profit";
import type { Currency } from "@/domain/types";

/**
 * The cash actually in hand, expressed as profit.
 *
 * An invoice is only partly settled, so only the collected part carries the
 * margin: `min(paid, total) × (grossProfit / total)`. On the owner's own
 * figures — 490 invoiced, 120 paid, 52.50 gross — that is 12.86, not the 52.50
 * the books show. A zero-value invoice has no margin to apportion.
 */
export function cashProfitCollected(total: number, paid: number, grossProfit: number): number {
  if (!(total > 0)) return 0;
  const cashCollected = Math.min(paid, total);
  return cashCollected * (grossProfit / total);
}

/**
 * «الوضع النقدي الحقيقي» — the number the owner actually asks for: what is in
 * the drawer, what that cash is worth as profit, what is owed out, and what is
 * still owed in. The bookkeeping profit card next door stays authoritative;
 * this one never recomputes it and never converts between currencies.
 */
export function CashPositionCard({ query }: { query: ProfitQueryParams }) {
  const filter = {
    type: "sale" as const,
    status: "active" as const,
    fromDate: query.fromDate,
    toDate: query.toDate,
    ...(query.currency ? { currency: query.currency } : {}),
  };
  const { data: invoiceData } = useInvoicesList(filter, { all: true });
  const { data: profitDetails } = useProfitDetails(query);
  const { data: summary } = useProfitSummary(query);
  const { data: balances } = useCashBalancesOn(localToday());

  // invoiceId → what that invoice's collected cash is worth as profit.
  const cashProfitByCurrency = useMemo(() => {
    const byInvoice = new Map<string, number>();
    for (const l of profitDetails?.invoiceLines ?? []) {
      byInvoice.set(l.invoiceId, l.grossProfit);
    }
    const totals = new Map<string, number>();
    for (const inv of invoiceData?.data ?? []) {
      const grossProfit = byInvoice.get(inv.id);
      if (grossProfit === undefined) continue;
      const share = cashProfitCollected(inv.total(), inv.paid ?? 0, grossProfit);
      totals.set(inv.currency, (totals.get(inv.currency) ?? 0) + share);
    }
    return totals;
  }, [invoiceData, profitDetails]);

  // Outstanding debts stay separate per currency and per direction.
  const debts = useMemo(() => {
    const out = new Map<string, number>();
    const owed = new Map<string, number>();
    for (const d of summary?.totalPayables ?? []) {
      out.set(d.currency, (out.get(d.currency) ?? 0) + (d.remaining ?? 0));
    }
    for (const d of summary?.totalReceivables ?? []) {
      owed.set(d.currency, (owed.get(d.currency) ?? 0) + (d.remaining ?? 0));
    }
    return { out, owed };
  }, [summary]);

  return (
    <section className="rounded-xl border border-border bg-card/60 p-4">
      <header className="mb-3 flex items-center gap-2">
        <Scale className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">الوضع النقدي الحقيقي</h2>
        <span className="text-xs text-muted-foreground">
          الكاش فعلياً — كل عملة صندوق مستقل، بلا تحويل
        </span>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        {CASH_BOXES.map(({ code, Icon }) => (
          <CurrencyPosition
            key={code}
            code={code}
            icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            inDrawer={balances?.[code] ?? 0}
            cashProfit={cashProfitByCurrency.get(code) ?? 0}
            payablesDue={debts.out.get(code) ?? 0}
            receivablesOpen={debts.owed.get(code) ?? 0}
          />
        ))}
      </div>
    </section>
  );
}

function CurrencyPosition({
  code,
  icon,
  inDrawer,
  cashProfit,
  payablesDue,
  receivablesOpen,
}: {
  code: Currency;
  icon: React.ReactNode;
  inDrawer: number;
  cashProfit: number;
  payablesDue: number;
  receivablesOpen: number;
}) {
  // The owner counts what is in the drawer against what must be paid out.
  // Receivables are not subtracted — they are not cash yet.
  const net = inDrawer - payablesDue;

  return (
    <article className="rounded-lg border border-border/80 bg-background/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        <span>{code}</span>
      </div>
      <Row label="الكاش في الدرج" value={inDrawer} code={code} />
      <Row label="الربح النقدي المحصّل" value={cashProfit} code={code} />
      <Row label="ذمم الموردين (واجبة الدفع)" value={payablesDue} code={code} />
      <Row label="ذمم العملاء (غير مقبوضة)" value={receivablesOpen} code={code} />
      <div className="mt-2 flex items-baseline justify-between border-t border-border/80 pt-2">
        <span className="text-xs font-semibold">صافي المركز النقدي</span>
        <span
          dir="ltr"
          className={cn(
            "text-sm font-bold tabular-nums",
            net > 0 ? "text-success" : net < 0 ? "text-destructive" : "text-foreground",
          )}
        >
          {formatMoney(net)} {currencySymbol(code)}
        </span>
      </div>
    </article>
  );
}

function Row({ label, value, code }: { label: string; value: number; code: Currency }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span dir="ltr" className="tabular-nums text-foreground">
        {formatMoney(value)} {currencySymbol(code)}
      </span>
    </div>
  );
}
