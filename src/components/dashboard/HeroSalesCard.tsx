import { Clock, Layers, FileWarning } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { useCashboxState } from "@/presentation/hooks/useCashbox";
import { formatSYP } from "@/presentation/hooks/useInventory";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


function formatUnpaidCurrencies(
  byCurrency: Record<string, { count: number; totalDue: number }> = {},
): string {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v && v.totalDue > 0)
    .map(([code, v]) => `${formatMoney(v.totalDue)} ${code}`);
  return parts.length > 0 ? parts.join(" · ") : formatSYP(0);
}

export function HeroSalesCard() {
  const { data } = useDashboard();
  const { data: cashbox } = useCashboxState();
  const { activeRolls, unpaidInvoices } = data ?? {};
  const hasSession = cashbox && cashbox.openingBalance > 0;

  // Format ISO string to time — returns the Latin-digit clock (e.g. "06:32") and the
  // Arabic period letter (e.g. "م") separately so we can lay them out cleanly with flex.
  const formatSessionTime = (isoString: string | undefined): { time: string; period: string } => {
    if (!isoString) return { time: "", period: "" };
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return { time: "", period: "" };
      const str = date.toLocaleTimeString("ar-SY", {
        hour: "2-digit",
        minute: "2-digit",
        numberingSystem: "latn",
      });
      const parts = str.trim().split(/\s+/);
      return { time: parts[0] ?? "", period: parts[1] ?? "" };
    } catch {
      return { time: "", period: "" };
    }
  };

  // Format a date string to DD-MM-YYYY using Latin digits (e.g. "13-08-2026"),
  // avoiding timezone shifts for plain "YYYY-MM-DD" values.
  const formatDate = (iso: string | undefined): string => {
    if (!iso) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  };

  const now = new Date();
  const session = formatSessionTime(hasSession ? now.toISOString() : "");
  const sessionTimeNum = hasSession ? session.time : "";
  const sessionPeriod = hasSession ? session.period : "";
  const sessionDate = hasSession && cashbox.openingDate ? formatDate(cashbox.openingDate) : "";

  return (
    <section
      className="card-glow relative overflow-hidden rounded-2xl border border-primary/20 p-3 sm:p-4 shadow-[0_8px_24px_-16px_color-mix(in_oklab,var(--primary)_40%,transparent)] transition-transform duration-200 hover:-translate-y-0.5"
      style={{ background: "var(--hero-card-bg)" }}
    >
      {/* Thin gold top bar */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{ background: "linear-gradient(90deg, transparent, var(--primary), transparent)" }}
      />

      <div className="relative">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div
              className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--accent-soft)" }}
            >
              افتتاح الجلسة
            </div>

            {/* Session opening time — number + period letter laid out with flex (RTL-safe) */}
            <div className="mt-1 flex items-baseline gap-2">
              {hasSession ? (
                <>
                  <span
                    dir="ltr"
                    className="text-5xl font-bold leading-none tracking-tight tabular-nums"
                    style={{ color: "var(--currency-syp)" }}
                  >
                    {sessionTimeNum}
                  </span>
                  {sessionPeriod && (
                    <span className="text-2xl font-medium text-muted-foreground">
                      {sessionPeriod}
                    </span>
                  )}
                </>
              ) : (
                <span
                  dir="ltr"
                  className="text-5xl font-bold leading-none tracking-tight tabular-nums"
                  style={{ color: "var(--currency-syp)" }}
                >
                  —
                </span>
              )}
            </div>
          </div>

          <div className="shrink-0">
            {hasSession ? (
              <div
                className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold"
                style={{ color: "var(--success)" }}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                مباشر
              </div>
            ) : (
              <div
                className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/30 bg-muted/20 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                الجلسة غير مفتوحة
              </div>
            )}
          </div>
        </div>

        {/* Inline secondary metrics */}
        <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-primary/10 pt-3 sm:grid-cols-1 md:grid-cols-3">
          <HeroChip icon={Clock} label="تاريخ الافتتاح" value={sessionDate || "—"} />
          <HeroChip
            icon={Layers}
            label="قطعة نشطة"
            value={formatMoney(activeRolls?.total ?? 0)}
          />
          <HeroChip
            icon={FileWarning}
            label="غير مسدَّدة"
            value={String(unpaidInvoices?.count ?? 0)}
            sub={formatUnpaidCurrencies(unpaidInvoices?.byCurrency)}
          />
        </div>
      </div>
    </section>
  );
}

function HeroChip({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-primary/20 bg-primary/10 text-primary">
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </div>
        <div className="text-sm font-bold text-foreground tabular-nums truncate">{value}</div>
        {sub && (
          <div className="text-[11px] text-muted-foreground tabular-nums truncate">{sub}</div>
        )}
      </div>
    </div>
  );
}
