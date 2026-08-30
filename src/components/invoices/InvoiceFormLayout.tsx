import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { formatThousands, parseAmount } from "@/presentation/hooks/useCurrency";

/**
 * Money/amount input that ACCEPTS thousand separators and decimal points
 * while typing (e.g. "55000" → shows "55,000" live; a trailing "," or "."
 * is preserved until the next digit lands). Reformats on blur. While the
 * user is mid-typing we display their raw text; once it ends with a digit
 * we show it formatted, so separators appear automatically without ever
 * eating a typed character.
 */
export function FormattedAmountInput({
  value,
  onChange,
  className,
  placeholder,
  ariaLabel,
  onKeyDown,
}: {
  value: number | "";
  onChange: (v: number | "") => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const endsWithSeparator = (s: string) => /[.,]\s*$/.test(s);
  const display =
    raw !== null
      ? raw.trim() === ""
        ? raw
        : endsWithSeparator(raw)
          ? raw
          : Number.isNaN(parseAmount(raw))
            ? raw
            : formatThousands(parseAmount(raw))
      : value === "" || value === 0
        ? ""
        : formatThousands(value);
  return (
    <Input
      type="text"
      inputMode="decimal"
      dir="ltr"
      value={display}
      onChange={(e) => {
        const v = e.target.value;
        setRaw(v);
        if (v.trim() === "") return onChange("");
        const n = parseAmount(v);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onBlur={() => setRaw(null)}
      onFocus={(e) =>
        e.currentTarget.setSelectionRange(
          e.currentTarget.value.length,
          e.currentTarget.value.length,
        )
      }
      onKeyDown={onKeyDown}
      className={className}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}

export function HeaderField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function CardField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

export function GroupSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-secondary/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="h-[3px] w-5 bg-primary/25 rounded-sm" />
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      {children}
    </div>
  );
}

export function TotalCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("mt-0.5 text-sm font-black tabular-nums", tone ?? "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

export function TotalInputCell({
  label,
  value,
  onChange,
  suffix,
  tone,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  suffix: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="relative mt-0.5">
        <FormattedAmountInput
          value={value}
          onChange={(v) => onChange(v === "" ? "" : Math.max(0, v))}
          className={cn("h-8 pl-9 text-left tabular-nums", tone)}
          placeholder="0"
        />
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  );
}

export function MoneyInputCell({
  label,
  value,
  onChange,
  suffix,
  tone,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  suffix: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="relative mt-0.5">
        <FormattedAmountInput
          value={value}
          onChange={(v) => {
            // Money cells (paid, discount…) must never go negative — a negative
            // discount would flip `subtotal - discount` into an addition and
            // inflate the grand total (e.g. 1,450 + 25,000 + 10,000 + 20,000).
            onChange(v === "" ? "" : Math.max(0, v));
          }}
          className={cn("h-8 pl-9 text-left tabular-nums", tone)}
          placeholder="0"
        />
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  );
}
