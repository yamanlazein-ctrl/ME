import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  colorById,
  fabricById,
  rollById,
  type Roll,
} from "@/presentation/hooks/useInventory";
import { formatQuantity } from "@/shared/utils/formatNumber";

function rollLabel(r: Roll): string {
  const c = colorById(r.colorId);
  const f = c ? fabricById(c.fabricId) : null;
  return `${f?.name ?? "—"} — ${c?.name ?? "—"} #${r.rollNo}`;
}

/**
 * Search-as-you-type dye/roll picker for return lines.
 * Empty query shows a capped list; typing filters by fabric, color, or roll no.
 */
export function RollSearchCombobox({
  value,
  options,
  onChange,
  placeholder = "ابحث عن صبغة...",
}: {
  value: string;
  options: Roll[];
  onChange: (rollId: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = value ? rollById(value) : null;
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return options.slice(0, 40);
    return options
      .filter((r) => {
        const c = colorById(r.colorId);
        const f = c ? fabricById(c.fabricId) : null;
        const hay = `${f?.name ?? ""} ${c?.name ?? ""} ${c?.code ?? ""} ${r.rollNo}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 40);
  }, [options, q]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-right text-sm font-medium hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
            !selected && "font-normal text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate">
            {selected ? rollLabel(selected) : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,90vw)] p-0" dir="rtl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="اكتب اسم القماش أو اللون أو رقم الصبغة..."
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              لا توجد صبغات مطابقة{q ? ` لـ «${query}»` : ""}.
            </div>
          )}
          {filtered.map((r) => {
            const c = colorById(r.colorId);
            const f = c ? fabricById(c.fabricId) : null;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  onChange(r.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-secondary"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">
                    {f?.name ?? "—"} — {c?.name ?? "—"}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground tabular-nums">
                    #{r.rollNo} · متبقّي {formatQuantity(r.remainingKg)} كغ
                  </div>
                </div>
                {r.id === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
