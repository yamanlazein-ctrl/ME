import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useProfitDetails, useProfitSummary } from "@/presentation/hooks/useProfit";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import type {
  DebtItemDTO,
  ProfitDetailLineDTO,
  ProfitExpenseRowDTO,
  ProfitQueryParams,
  ProfitSummaryByCurrencyDTO,
} from "@/contracts/profit";

const cur = (c: string): Currency => c as Currency;

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{k}</dt>
      <dd
        className={`tabular-nums ${strong ? "font-bold text-foreground" : "font-medium"}`}
        dir="ltr"
      >
        {v}
      </dd>
    </div>
  );
}

/** Labeled in-card loading — never an anonymous dark box. */
function CardLoading({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="text-xs text-muted-foreground">{label}…</div>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/**
 * FINANCIAL OVERVIEW — profitability & debts side-by-side.
 * Each card owns its loading/error state independently, so one failing
 * request can never blank out the other (root cause fix for the "two empty
 * black boxes": profit endpoints were 404ing and both cards blocked together).
 */
export function FinancialOverview({ query }: { query: ProfitQueryParams }) {
  const summary = useProfitSummary(query);
  const details = useProfitDetails(query);

  useEffect(() => {
    if (summary.error) console.error("[cashbox] profit/summary failed:", summary.error);
  }, [summary.error]);
  useEffect(() => {
    if (details.error) console.error("[cashbox] profit/details failed:", details.error);
  }, [details.error]);

  return (
    <section aria-label="النظرة المالية العامة" className="grid gap-3 lg:grid-cols-2">
      <ProfitabilityCard summary={summary} details={details} />
      <DebtsCard state={summary} invoiceLines={details.data?.invoiceLines ?? []} />
    </section>
  );
}

type SummaryQuery = ReturnType<typeof useProfitSummary>;
type DetailsQuery = ReturnType<typeof useProfitDetails>;

function ProfitabilityCard({ summary, details }: { summary: SummaryQuery; details: DetailsQuery }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">الربحية</h3>
        <span className="text-[10px] text-muted-foreground">الإيراد − COGS − المصاريف</span>
      </div>

      {summary.isLoading || details.isLoading ? (
        <CardLoading label="جارٍ تحميل الأرباح" />
      ) : summary.isError || details.isError ? (
        <ErrorState
          title="تعذر تحميل الأرباح"
          onRetry={() => {
            void summary.refetch();
            void details.refetch();
          }}
          className="py-6"
        />
      ) : (summary.data?.byCurrency?.length ?? 0) === 0 ? (
        <EmptyState
          title="لا أرباح في هذه الفترة"
          description="لا فواتير بيع نشطة مطابقة للفلترة."
          className="py-8"
        />
      ) : (
        <>
          <div className="space-y-3">
            {(summary.data?.byCurrency ?? []).map((b) => (
              <div key={b.currency} className="rounded-lg border border-border p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-semibold text-muted-foreground">
                    صافي الربح
                    <span className="mr-1 rounded bg-secondary px-1 text-[10px]">{b.currency}</span>
                  </span>
                  <span
                    className={`text-xl font-extrabold tabular-nums ${
                      b.netProfit < 0 ? "text-destructive" : "text-success"
                    }`}
                    dir="ltr"
                  >
                    {formatAmount(b.netProfit, cur(b.currency))}
                  </span>
                </div>
                <dl className="mt-2 space-y-1 text-xs">
                  <Row k="الإيرادات" v={formatAmount(b.salesRevenue, cur(b.currency))} />
                  <Row k="تكلفة البضاعة (COGS)" v={`− ${formatAmount(b.cogs, cur(b.currency))}`} />
                  <Row k="المصاريف" v={`− ${formatAmount(b.expenses, cur(b.currency))}`} />
                  <Row k="الربح الإجمالي" v={formatAmount(b.grossProfit, cur(b.currency))} strong />
                </dl>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  عدد الفواتير: {b.invoiceCount}
                </div>
              </div>
            ))}
          </div>

          {/* تفاصيل قابلة للطي */}
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 w-full gap-1 text-primary"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                />
                {open ? "إخفاء التفاصيل" : "عرض التفاصيل لكل فاتورة"}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border">
                {(details.data?.invoiceLines?.length ?? 0) === 0 ? (
                  <EmptyState title="لا تفاصيل فواتير" className="py-6" />
                ) : (
                  <table className="w-full text-right text-xs">
                    <thead className="sticky top-0 bg-card text-[10px] font-semibold uppercase text-muted-foreground">
                      <tr className="[&>th]:px-3 [&>th]:py-1.5">
                        <th>الفاتورة</th>
                        <th>العميل</th>
                        <th className="text-left">الإيراد</th>
                        <th className="text-left">COGS</th>
                        <th className="text-left">الربح</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {(details.data?.invoiceLines ?? []).map((l) => (
                        <tr key={l.invoiceId} className="hover:bg-secondary/40">
                          <td className="px-3 py-1.5">
                            <Link
                              to="/invoices/$id"
                              params={{ id: l.invoiceId }}
                              className="font-semibold tabular-nums text-primary hover:underline"
                            >
                              {l.number}
                            </Link>
                          </td>
                          <td className="max-w-[110px] truncate px-3 py-1.5">{l.partyName}</td>
                          <td className="px-3 py-1.5 text-left tabular-nums" dir="ltr">
                            {formatAmount(l.revenue, cur(l.currency))}
                          </td>
                          <td className="px-3 py-1.5 text-left tabular-nums" dir="ltr">
                            {formatAmount(l.cogs, cur(l.currency))}
                          </td>
                          <td
                            className={`px-3 py-1.5 text-left font-bold tabular-nums ${
                              l.grossProfit < 0 ? "text-destructive" : ""
                            }`}
                            dir="ltr"
                          >
                            {formatAmount(l.grossProfit, cur(l.currency))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {(details.data?.expenses?.length ?? 0) > 0 && (
                <div className="mt-2 flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    المصاريف في الفترة: <b>{details.data?.expenses.length}</b>
                  </span>
                  <Link to="/expenses" className="font-semibold text-primary hover:underline">
                    صفحة المصاريف ←
                  </Link>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}

function DebtsCard({
  state,
  invoiceLines,
}: {
  state: SummaryQuery;
  invoiceLines: ProfitDetailLineDTO[];
}) {
  void invoiceLines; // reserved: per-invoice drill-down inside debts
  const [open, setOpen] = useState(false);
  const receivables = state.data?.totalReceivables ?? [];
  const payables = state.data?.totalPayables ?? [];
  const overdue = receivables.filter((d) => d.daysOverdue > 0);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">الذمم والالتزامات</h3>
        <span className="text-[10px] text-muted-foreground">لا تُخصم من الربح</span>
      </div>

      {state.isLoading ? (
        <CardLoading label="جارٍ تحميل الذمم" />
      ) : state.isError ? (
        <ErrorState
          title="تعذر تحميل الذمم"
          onRetry={() => void state.refetch()}
          className="py-6"
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <DebtStat label="مستحق لنا" items={receivables} tone="in" />
            <DebtStat label="مستحق علينا" items={payables} tone="out" />
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
              <div className="text-[10px] font-semibold uppercase text-muted-foreground">متأخر</div>
              <div className="mt-1 text-base font-bold tabular-nums text-warning">
                {overdue.length}
              </div>
              <div className="text-[10px] text-muted-foreground">فاتورة متأخرة السداد</div>
            </div>
          </div>

          {receivables.length === 0 && payables.length === 0 ? (
            <EmptyState
              title="لا ذمم مستحقة"
              description="كل الفواتير في هذه الفترة مسددة."
              className="py-6"
            />
          ) : (
            <Collapsible open={open} onOpenChange={setOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full gap-1 text-primary"
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
                  />
                  {open ? "إخفاء الجداول" : "عرض جداول الذمم"}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                <DebtTable title="ذمم العملاء (Receivables)" items={receivables} />
                <DebtTable title="ذمم الموردين (Payables)" items={payables} />
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

function DebtStat({
  label,
  items,
  tone,
}: {
  label: string;
  items: DebtItemDTO[];
  tone: "in" | "out";
}) {
  const sums = (() => {
    const m = new Map<string, number>();
    for (const d of items) m.set(d.currency, (m.get(d.currency) ?? 0) + d.remaining);
    return [...m.entries()];
  })();
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      {sums.length === 0 ? (
        <div className="mt-1 text-sm font-bold text-muted-foreground">—</div>
      ) : (
        sums.map(([c, v]) => (
          <div
            key={c}
            className={`mt-1 text-sm font-bold tabular-nums ${
              tone === "out" ? "text-destructive" : "text-foreground"
            }`}
            dir="ltr"
          >
            {formatAmount(v, cur(c))}
          </div>
        ))
      )}
    </div>
  );
}

function DebtTable({ title, items }: { title: string; items: DebtItemDTO[] }) {
  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border bg-secondary/50 px-3 py-1.5 text-xs font-bold">
        {title} <span className="font-normal text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="p-3 text-center text-xs text-muted-foreground">لا يوجد.</div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-right text-xs">
            <thead className="sticky top-0 bg-card text-[10px] font-semibold uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-1.5">
                <th>الفاتورة</th>
                <th>الطرف</th>
                <th>التاريخ</th>
                <th className="text-left">المتبقي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {items.map((d) => (
                <tr key={d.invoiceId} className="hover:bg-secondary/40">
                  <td className="px-3 py-1.5">
                    <Link
                      to="/invoices/$id"
                      params={{ id: d.invoiceId }}
                      className="font-semibold tabular-nums text-primary hover:underline"
                    >
                      {d.number}
                    </Link>
                    {d.daysOverdue > 0 && (
                      <span className="mr-1 rounded bg-destructive/15 px-1 text-[9px] font-semibold text-destructive">
                        {d.daysOverdue}ي
                      </span>
                    )}
                  </td>
                  <td className="max-w-[110px] truncate px-3 py-1.5">{d.partyName || "—"}</td>
                  <td className="px-3 py-1.5 tabular-nums">{d.date}</td>
                  <td className="px-3 py-1.5 text-left font-bold tabular-nums" dir="ltr">
                    {formatAmount(d.remaining, cur(d.currency))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
