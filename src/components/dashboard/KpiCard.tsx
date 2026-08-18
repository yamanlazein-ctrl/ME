import { ArrowDownRight, ArrowUpRight, ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DualCurrency } from "@/components/common/DualCurrency";

type Trend = "up" | "down" | "neutral";

export function KpiCard({
  title,
  icon: Icon,
  primary,
  secondary,
  trend,
  trendValue,
  footer,
  footerHref = "#",
  emphasis = false,
  syp,
  usd,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  primary?: ReactNode;
  secondary?: ReactNode;
  trend?: Trend;
  trendValue?: string;
  footer?: string;
  footerHref?: string;
  emphasis?: boolean;
  syp?: number;
  usd?: number;
  children?: ReactNode;
}) {
  return (
    <div
      className={`card-glow group relative flex flex-col justify-between rounded-xl border bg-card p-4 shadow-soft cursor-pointer transition hover:border-primary/40 ${
        emphasis ? "border-primary/30" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] font-medium text-muted-foreground">{title}</div>
        {Icon && (
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-secondary text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition">
            <Icon className="h-4 w-4" strokeWidth={2} />
          </div>
        )}
      </div>

      {(syp !== undefined || usd !== undefined) && (
        <div className="mt-4">
          <DualCurrency syp={syp} usd={usd} size="lg" align="start" />
          {trend && trendValue && (
            <span
              className={`mt-2 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                trend === "up"
                  ? "bg-success/15 text-success"
                  : trend === "down"
                    ? "bg-destructive/15 text-destructive"
                    : "bg-secondary text-muted-foreground"
              }`}
            >
              {trend === "up" ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : trend === "down" ? (
                <ArrowDownRight className="h-3 w-3" />
              ) : null}
              {trendValue}
            </span>
          )}
        </div>
      )}

      {syp === undefined && usd === undefined && (primary || secondary || trendValue) && (
        <div className="mt-3 space-y-1">
          {primary && (
            <div className="text-2xl font-bold text-foreground tabular-nums leading-tight">
              {primary}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs">
            {secondary && <span className="text-muted-foreground tabular-nums">{secondary}</span>}
            {trend && trendValue && (
              <span
                className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                  trend === "up"
                    ? "bg-success/15 text-success"
                    : trend === "down"
                      ? "bg-destructive/15 text-destructive"
                      : "bg-secondary text-muted-foreground"
                }`}
              >
                {trend === "up" ? (
                  <ArrowUpRight className="h-3 w-3" />
                ) : trend === "down" ? (
                  <ArrowDownRight className="h-3 w-3" />
                ) : null}
                {trendValue}
              </span>
            )}
          </div>
        </div>
      )}

      {children}

      {footer && (
        <a
          href={footerHref}
          className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {footer}
          <ChevronLeft className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}
