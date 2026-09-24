import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CURRENCIES } from "@/presentation/hooks/useCurrency";

import { localDateISO } from "@/lib/localDate";
export type CashboxPeriodFilter = {
  from: string; // yyyy-mm-dd
  to: string; // yyyy-mm-dd
  currency: string; // "SYP" | "USD" | "EUR" | "all"
};

function isoDay(d: Date): string {
  return localDateISO(d);
}

/**
 * Compact filter TOOLBAR (not a content card) — presets + range + currency.
 * Every period-scoped section on the page reads the same values, so the
 * displayed filter always matches what is sent to the API (single source).
 */
export function PeriodFilterCard({
  value,
  onChange,
}: {
  value: CashboxPeriodFilter;
  onChange: (patch: Partial<CashboxPeriodFilter>) => void;
}) {
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  const weekAgo = isoDay(new Date(Date.now() - 6 * 86_400_000));
  const monthStart = isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const presets: Array<{ label: string; from: string; to: string }> = [
    { label: "اليوم", from: today, to: today },
    { label: "أمس", from: yesterday, to: yesterday },
    { label: "٧ أيام", from: weekAgo, to: today },
    { label: "هذا الشهر", from: monthStart, to: today },
  ];

  return (
    <div
      role="toolbar"
      aria-label="فلترة الفترة والعملة"
      className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3"
    >
      <div className="flex items-center gap-1">
        <span className="ml-1 text-xs font-semibold text-muted-foreground">الفترة:</span>
        {presets.map((p) => {
          const active = value.from === p.from && value.to === p.to;
          return (
            <Button
              key={p.label}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              className={
                active
                  ? "h-8 border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                  : "h-8 text-muted-foreground"
              }
              onClick={() => onChange({ from: p.from, to: p.to })}
            >
              {p.label}
            </Button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <div>
          <Label className="text-[10px] text-muted-foreground">من</Label>
          <Input
            type="date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => e.target.value && onChange({ from: e.target.value })}
            className="h-8 w-36 text-xs"
          />
        </div>
        <div>
          <Label className="text-[10px] text-muted-foreground">إلى</Label>
          <Input
            type="date"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => e.target.value && onChange({ to: e.target.value })}
            className="h-8 w-36 text-xs"
          />
        </div>
      </div>

      <div>
        <Label className="text-[10px] text-muted-foreground">العملة</Label>
        <Select value={value.currency} onValueChange={(v) => onChange({ currency: v })}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل العملات</SelectItem>
            {CURRENCIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
