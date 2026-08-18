import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { customers, suppliers } from "@/presentation/hooks/useParties";

/**
 * Searchable party (customer/supplier) combobox for use in forms.
 * - Type to filter the party list by name / phone / city immediately.
 * - If no match exists, an "add new" empty-state action is shown.
 *
 * Mirrors the app's existing comboboxes (SupplierInlineCombobox / FabricCombobox)
 * and keeps the same RTL / dark-light design tokens.
 */
export function PartyCombobox({
  kind,
  value,
  onChange,
  onCreateNew,
  placeholder,
}: {
  kind: "customer" | "supplier";
  value: string;
  onChange: (id: string) => void;
  /** Triggered by the "إضافة جديد" empty-state action. */
  onCreateNew: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const list = kind === "customer" ? customers : suppliers;
  const selected = list.find((p) => p.id === value);
  const entity = kind === "customer" ? "عميل" : "مورد";
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return list.slice(0, 50);
    return list.filter(
      (p) =>
        (p.name ?? "").toLowerCase().includes(q) ||
        (p.phone ?? "").toLowerCase().includes(q) ||
        (p.city ?? "").toLowerCase().includes(q),
    );
  }, [q, list]);

  const noMatch = q.length > 0 && filtered.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-right text-sm font-medium hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
            !selected && "font-normal text-muted-foreground",
          )}
        >
          <span className="truncate">
            {selected?.name ?? placeholder ?? (kind === "customer" ? "اختر العميل" : "اختر المورد")}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0" dir="rtl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`ابحث عن ${entity} بالاسم أو الهاتف...`}
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {noMatch && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              لا توجد نتائج مطابقة لـ «{query}».
            </div>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(p.id);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-secondary"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{p.name}</div>
                {p.phone && (
                  <div
                    dir="ltr"
                    className="truncate text-right text-[11px] text-muted-foreground tabular-nums"
                  >
                    {p.phone}
                  </div>
                )}
              </div>
              {p.id === value && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onCreateNew();
          }}
          className="flex w-full items-center gap-2 border-t border-border bg-primary/5 px-3 py-2.5 text-right text-sm font-semibold text-primary hover:bg-primary/10"
        >
          <Plus className="h-4 w-4" />
          {noMatch ? `الاسم غير موجود. + إضافة ${entity} جديد` : `إضافة ${entity} جديد`}
        </button>
      </PopoverContent>
    </Popover>
  );
}
