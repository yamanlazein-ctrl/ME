import { formatAmount, CURRENCIES } from "@/presentation/hooks/useCurrency";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";
import type { Currency } from "@/domain/types";

/**
 * TOP FINANCIAL SUMMARY — treasury-style hierarchy:
 *   ONE hero metric (current balance) dominates; everything else is clearly
 *   secondary. Hero stays NEUTRAL so the red negative state (kept, per
 *   fintech semantic-color practice) never competes with decorative gold.
 *   A data-freshness timestamp builds trust in the critical number.
 */
export function FinancialSummary({
  currentBalance,
  todayIn,
  todayOut,
  txCount,
  openingBalance,
  openingCurrency,
  openingDate,
  perCurrency,
  lastUpdatedAt,
}: {
  currentBalance: number;
  todayIn: number;
  todayOut: number;
  txCount: number;
  openingBalance: number;
  openingCurrency: string;
  openingDate: string;
  perCurrency: Record<string, number>;
  /** React Query dataUpdatedAt (ms epoch) for the balance query. */
  lastUpdatedAt?: number;
}) {
  const hydrated = useHydrated();
  const negative = currentBalance < 0;
  const freshTime =
    hydrated && lastUpdatedAt
      ? new Date(lastUpdatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return (
    <section aria-label="الملخص المالي" className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      {/* Tier 1 — THE hero. Neutral chrome; red only when truly negative. */}
      <div
        className={cn(
          "rounded-xl border bg-card p-6 md:col-span-2 lg:row-span-2",
          negative ? "border-destructive/50" : "border-border",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            الرصيد الحالي (نقداً)
          </div>
          {/* Data freshness signal — treasury dashboards always show recency */}
          <div
            className="text-[10px] text-muted-foreground tabular-nums"
            title="وقت آخر تحديث للرصيد من الخادم"
          >
            آخر تحديث: {freshTime ?? "—"}
          </div>
        </div>

        <div
          className={cn(
            "mt-3 text-4xl font-extrabold tracking-tight tabular-nums",
            negative ? "text-destructive" : "text-foreground",
          )}
          dir="ltr"
        >
          {/* formatAmount already includes the symbol — never append it again */}
          {formatAmount(currentBalance, "SYP")}
        </div>

        {negative && (
          <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive">
            رصيد سالب — الصادر تجاوز الوارد
          </div>
        )}

        {/* Per-currency balances — clearly readable (USD/EUR are first-class,
            not faded chips): code + label on one side, full amount with its
            own symbol on the other. Never summed across currencies. */}
        <div className="mt-5 space-y-1.5 border-t border-border pt-3">
          {CURRENCIES.map((c) => {
            const v = perCurrency[c.code] ?? 0;
            return (
              <div key={c.code} className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-muted-foreground">
                  <span className="font-bold text-foreground/80">{c.code}</span>
                  {" — "}
                  {c.label}
                </span>
                <span
                  className={cn(
                    "text-sm font-bold tabular-nums",
                    v < 0 ? "text-destructive" : "text-foreground",
                  )}
                  dir="ltr"
                >
                  {formatAmount(v, c.code as Currency)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 border-t border-border pt-2 text-xs text-muted-foreground">
          الافتتاحي ({openingDate || "—"}):{" "}
          <span className="font-semibold text-foreground tabular-nums" dir="ltr">
            {formatAmount(openingBalance, openingCurrency as Currency)}
          </span>
        </div>
      </div>

      {/* Tier 2 — calm, uniform, clearly secondary */}
      <StatCard label="وارد اليوم" value={todayIn} tone="in" />
      <StatCard label="صادر اليوم" value={todayOut} tone="out" />
      <StatCard
        label="صافي حركة اليوم"
        value={todayIn - todayOut}
        tone={todayIn - todayOut >= 0 ? "in" : "out"}
      />
      <StatCard label="عدد حركات اليوم" value={txCount} isCount />
    </section>
  );
}

function StatCard({
  label,
  value,
  tone,
  isCount,
}: {
  label: string;
  value: number;
  tone?: "in" | "out";
  isCount?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 tabular-nums",
          isCount ? "text-lg font-bold text-foreground" : "text-base font-semibold",
          tone === "in" && !isCount && "text-success/90",
          tone === "out" && !isCount && "text-destructive/90",
        )}
        dir={isCount ? undefined : "ltr"}
      >
        {/* formatAmount already appends the currency symbol — no extra suffix */}
        {isCount ? String(value) : formatAmount(value, "SYP")}
      </div>
    </div>
  );
}