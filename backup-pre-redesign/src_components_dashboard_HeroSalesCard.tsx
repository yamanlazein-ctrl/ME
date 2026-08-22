import { Link } from "@tanstack/react-router";
import { Clock, Layers, PackageOpen } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { useCashboxState } from "@/presentation/hooks/useCashbox";
import { useOrdersList } from "@/presentation/hooks/useOrders";
import { formatMoney } from "@/shared/utils/formatNumber";

export function HeroSalesCard() {
  const { data } = useDashboard();
  const { data: cashbox } = useCashboxState();
  const { activeRolls } = data ?? {};
  const { data: ordersData } = useOrdersList();
  const availableOrders = (ordersData?.data ?? []).filter(
    (o) => o.status === "available" || o.status === "partially_available",
  ).length;
  const hasSession = cashbox && cashbox.openingBalance > 0;

  const formatSessionTime = (
    isoString: string | undefined,
  ): { time: string; period: string } => {
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
  const sessionDate =
    hasSession && cashbox.openingDate ? formatDate(cashbox.openingDate) : "";

  return (
    <section
      data-od-id="hero-session"
      className="card-glow relative overflow-hidden rounded-2xl border border-primary/25 p-5 shadow-[0_24px_60px_-30px_color-mix(in_oklab,var(--primary)_45%,transparent)] transition-transform duration-300 hover:-translate-y-0.5 sm:p-6"
      style={{ background: "var(--hero-card-bg)" }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--primary), transparent)",
        }}
      />
      <div
        className="pointer-events-none absolute h-56 w-56 rounded-full opacity-40 blur-3xl"
        style={{
          top: "-3rem",
          insetInlineStart: "-1rem",
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--primary) 50%, transparent), transparent 70%)",
        }}
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--accent-soft)" }}
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={2} />
            افتتاح الجلسة
          </div>
          <div className="mt-1 flex items-baseline gap-2.5">
            <span
              dir="ltr"
              className="text-6xl font-bold leading-none tracking-tight tabular-nums sm:text-7xl"
              style={{ color: "var(--foreground)" }}
            >
              {hasSession ? sessionTimeNum : "—"}
            </span>
            {hasSession && sessionPeriod && (
              <span className="text-2xl font-semibold text-muted-foreground">
                {sessionPeriod}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {hasSession
              ? "الجلسة مفتوحة — العمليات مسجّلة لحظياً"
              : "لا توجد جلسة مفتوحة حالياً"}
          </p>
        </div>

        <div className="shrink-0">
          {hasSession ? (
            <div
              className="inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-[11px] font-semibold"
              style={{ color: "var(--success)" }}
            >
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              مباشر
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full border border-muted-foreground/30 bg-muted/30 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/60" />
              الجلسة غير مفتوحة
            </div>
          )}
        </div>
      </div>

      <div className="relative mt-5 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-primary/10 bg-primary/5 sm:grid-cols-3">
        <HeroChip
          icon={Clock}
          label="تاريخ الافتتاح"
          value={sessionDate || "—"}
        />
        <HeroChip
          icon={Layers}
          label="قطعة نشطة"
          value={formatMoney(activeRolls?.total ?? 0)}
        />
        <HeroChip
          icon={PackageOpen}
          label="الطلبات المتاحة"
          value={String(availableOrders)}
          to="/orders"
        />
      </div>
    </section>
  );
}

function HeroChip({
  icon: Icon,
  label,
  value,
  to,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  to?: string;
}) {
  const inner = (
    <div className="flex h-full items-center gap-3 bg-card/60 px-4 py-3.5 transition-colors duration-200 hover:bg-card">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 truncate text-base font-bold tabular-nums text-foreground">
          {value}
        </div>
      </div>
    </div>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {inner}
      </Link>
    );
  }
  return <div className="h-full">{inner}</div>;
}
