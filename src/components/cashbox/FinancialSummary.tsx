import { Banknote, DollarSign, Euro, ArrowDownLeft, ArrowUpRight, Activity } from "lucide-react";
import type { ReactNode } from "react";
import { formatAmount, CURRENCIES } from "@/presentation/hooks/useCurrency";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";
import type { Currency } from "@/domain/types";

/** Three independent cash boxes — never mixed or FX-converted. */
const CASH_BOXES: {
  code: Currency;
  Icon: typeof Banknote;
  accent: string;
  chip: string;
}[] = [
  {
    code: "SYP",
    Icon: Banknote,
    accent: "from-emerald-500/15 via-transparent to-transparent",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  {
    code: "USD",
    Icon: DollarSign,
    accent: "from-sky-500/15 via-transparent to-transparent",
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  {
    code: "EUR",
    Icon: Euro,
    accent: "from-violet-500/15 via-transparent to-transparent",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
];

function StatCell({
  label,
  icon,
  value,
  valueClass,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  valueClass: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("text-sm font-semibold tabular-nums leading-none", valueClass)} dir="ltr">
        {value}
      </div>
    </div>
  );
}

/**
 * TOP FINANCIAL SUMMARY — three equal currency boxes, identical internal order:
 * header → balance → status → وارد/صادر/صافي (label then number) → opening slot.
 */
export function FinancialSummary({
  todayFlowByCurrency,
  txCount,
  openingBalance,
  openingCurrency,
  openingDate,
  perCurrency,
  lastUpdatedAt,
}: {
  todayFlowByCurrency: Record<string, { in: number; out: number }>;
  txCount: number;
  openingBalance: number;
  openingCurrency: string;
  openingDate: string;
  perCurrency: Record<string, number>;
  lastUpdatedAt?: number;
}) {
  const hydrated = useHydrated();
  const freshTime =
    hydrated && lastUpdatedAt
      ? new Date(lastUpdatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <section aria-label="الملخص المالي" className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-stretch">
        {CASH_BOXES.map(({ code, Icon, accent, chip }) => {
          const meta = CURRENCIES.find((c) => c.code === code);
          const balance = perCurrency[code] ?? 0;
          const flow = todayFlowByCurrency[code] ?? { in: 0, out: 0 };
          const net = flow.in - flow.out;
          const negative = balance < 0;
          const isOpeningBox = openingCurrency === code && !!openingDate;

          return (
            <article
              key={code}
              className={cn(
                "relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card p-5 shadow-soft",
                negative ? "border-destructive/45" : "border-border",
              )}
            >
              <div
                className={cn("pointer-events-none absolute inset-0 bg-gradient-to-bl", accent)}
                aria-hidden
              />

              {/* 1. Header — same in every box */}
              <div className="relative flex items-center gap-2.5">
                <span
                  className={cn(
                    "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                    chip,
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={2.25} />
                </span>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                    صندوق {meta?.label ?? code}
                  </div>
                  <div className="text-xs font-bold text-foreground/80">{code}</div>
                </div>
              </div>

              {/* 2. Balance */}
              <div
                className={cn(
                  "relative mt-4 text-2xl font-extrabold tracking-tight tabular-nums sm:text-[1.7rem]",
                  negative ? "text-destructive" : "text-foreground",
                )}
                dir="ltr"
              >
                {formatAmount(balance, code)}
              </div>

              {/* 3. Status row — reserved height so all boxes align */}
              <div className="relative mt-2 flex h-6 items-center">
                {negative ? (
                  <span className="inline-flex items-center rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                    رصيد سالب
                  </span>
                ) : null}
              </div>

              {/* 4. وارد / صادر / صافي — label above number, identical columns */}
              <div className="relative mt-auto grid grid-cols-3 gap-3 border-t border-border/80 pt-3">
                <StatCell
                  label="وارد"
                  icon={<ArrowDownLeft className="h-3 w-3 text-success" />}
                  value={formatAmount(flow.in, code)}
                  valueClass="text-success"
                />
                <StatCell
                  label="صادر"
                  icon={<ArrowUpRight className="h-3 w-3 text-destructive" />}
                  value={formatAmount(flow.out, code)}
                  valueClass="text-destructive"
                />
                <StatCell
                  label="صافي اليوم"
                  value={formatAmount(net, code)}
                  valueClass={
                    net > 0
                      ? "text-success"
                      : net < 0
                        ? "text-destructive"
                        : "text-foreground"
                  }
                />
              </div>

              {/* 5. Opening slot — same height on every box */}
              <div className="relative mt-2 min-h-[1.1rem] text-[10px] text-muted-foreground">
                {isOpeningBox ? (
                  <>
                    افتتاحي {openingDate}:{" "}
                    <span className="font-semibold tabular-nums text-foreground" dir="ltr">
                      {formatAmount(openingBalance, code)}
                    </span>
                  </>
                ) : (
                  <span className="invisible">—</span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card/70 px-4 py-2.5 text-xs text-muted-foreground">
        <div className="inline-flex items-center gap-2 font-medium text-foreground">
          <Activity className="h-3.5 w-3.5 text-primary" />
          حركات اليوم (كل العملات)
          <span className="rounded-md bg-secondary px-2 py-0.5 font-bold tabular-nums">
            {txCount}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {freshTime ? (
            <span className="tabular-nums" title="وقت آخر تحديث للرصيد من الخادم">
              حدّث {freshTime}
            </span>
          ) : null}
          <span>كل صندوق مستقل — لا تحويل تلقائي بين العملات</span>
        </div>
      </div>
    </section>
  );
}
