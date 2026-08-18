import { cn } from "@/lib/utils";
import { currencyState, currencySymbol, type Currency } from "@/presentation/hooks/useCurrency";

/**
 * Renders a monetary value twice — SYP (primary gold) and USD (soft cream).
 * Layout: currency symbol on the LEFT edge, number to its right.
 * The whole block is left-aligned by default.
 */
export function DualCurrency({
  syp,
  usd,
  size = "md",
  align = "start",
  className,
}: {
  syp?: number;
  usd?: number;
  size?: "sm" | "md" | "lg" | "xl";
  align?: "start" | "end" | "center";
  className?: string;
}) {
  const rateUsd = currencyState.rates.USD; // SYP per 1 USD
  const sypVal = syp ?? (usd ?? 0) * rateUsd;
  const usdVal = usd ?? (syp ?? 0) / rateUsd;

  const sizes: Record<string, { primary: string; secondary: string; sym: string; symSec: string }> =
    {
      sm: { primary: "text-sm", secondary: "text-sm", sym: "text-[11px]", symSec: "text-[11px]" },
      md: { primary: "text-base", secondary: "text-[15px]", sym: "text-xs", symSec: "text-xs" },
      lg: { primary: "text-xl", secondary: "text-lg", sym: "text-sm", symSec: "text-sm" },
      xl: { primary: "text-3xl", secondary: "text-2xl", sym: "text-lg", symSec: "text-base" },
    };
  const s = sizes[size];
  const alignCls =
    align === "start"
      ? "items-start text-start"
      : align === "center"
        ? "items-center text-center"
        : "items-end text-end";

  const symSyp = currencySymbol("SYP" as Currency);
  const symUsd = currencySymbol("USD" as Currency);

  const fmt = (n: number, decimals = 0) =>
    (decimals === 0 ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

  return (
    <div className={cn("flex flex-col leading-tight", alignCls, className)} dir="ltr">
      <span
        className={cn("inline-flex items-baseline gap-1 font-bold tabular-nums", s.primary)}
        style={{ color: "var(--currency-syp)" }}
      >
        <span className={cn("font-semibold opacity-80", s.sym)}>{symSyp}</span>
        <span>{fmt(sypVal)}</span>
      </span>
      <span
        className={cn("inline-flex items-baseline gap-1 font-bold tabular-nums", s.secondary)}
        style={{ color: "var(--currency-usd)" }}
      >
        <span className={cn("font-bold", s.symSec)}>{symUsd}</span>
        <span>{fmt(usdVal, 2)}</span>
      </span>
    </div>
  );
}
