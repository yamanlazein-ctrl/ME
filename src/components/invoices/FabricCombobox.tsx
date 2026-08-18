import { useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fabrics } from "@/presentation/hooks/useInventory";

export function FabricCombobox({
  value,
  onChange,
  onCreateNew,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  onCreateNew: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = fabrics.find((f) => f.id === value);
  const q = query.trim().toLowerCase();
  const list = q
    ? fabrics.filter(
        (f) => f.name.toLowerCase().includes(q) || (f.category ?? "").toLowerCase().includes(q),
      )
    : fabrics;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-10 w-full items-center justify-between rounded-md border border-transparent bg-background px-3 text-right text-sm hover:border-border focus:border-primary focus:outline-none",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{selected?.name ?? "اختر القماش"}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-0" dir="rtl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث عن قماش..."
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {list.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              لا توجد نتائج مطابقة
            </div>
          )}
          {list.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                onChange(f.id);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-secondary"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{f.name}</div>
                {f.category && (
                  <div className="truncate text-[11px] text-muted-foreground">{f.category}</div>
                )}
              </div>
              {f.id === value && <Check className="h-4 w-4 text-primary" />}
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
          <Plus className="h-4 w-4" /> إضافة قماش جديد
        </button>
      </PopoverContent>
    </Popover>
  );
}
