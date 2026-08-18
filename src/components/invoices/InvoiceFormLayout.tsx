import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { formatThousands, parseAmount } from "@/presentation/hooks/useCurrency";

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
    <div className="rounded-md border border-border/60 bg-secondary/20 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
          {title}
        </span>
        <div className="h-px flex-1 bg-border/70" />
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
      <span className={cn("mt-0.5 text-sm font-bold tabular-nums", tone ?? "text-foreground")}>
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
        <Input
          type="number"
          min={0}
          className={cn("h-8 pl-9 text-left tabular-nums", tone)}
          value={value}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
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
  const text = value === "" || value === 0 ? "" : formatThousands(value);
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="relative mt-0.5">
        <Input
          type="text"
          inputMode="numeric"
          dir="ltr"
          className={cn("h-8 pl-9 text-left tabular-nums", tone)}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange("");
            const n = parseAmount(raw);
            onChange(Number.isNaN(n) ? value : n);
          }}
          onFocus={(e) =>
            e.currentTarget.setSelectionRange(
              e.currentTarget.value.length,
              e.currentTarget.value.length,
            )
          }
          placeholder="0"
        />
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  );
}
