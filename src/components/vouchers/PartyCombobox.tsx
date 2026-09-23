import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { container } from "@/infrastructure/container";

type PartyHit = {
  id: string;
  name: string;
  code?: string | null;
  phone?: string | null;
  kind: string;
};

/**
 * Server-side typeahead party combobox (OLD-PLAN Phase 2 — no full party preload).
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
  onCreateNew: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PartyHit[]>([]);
  const [selected, setSelected] = useState<PartyHit | null>(null);
  const [loading, setLoading] = useState(false);
  const entity = kind === "customer" ? "عميل" : "مورد";

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    let cancelled = false;
    void (async () => {
      try {
        const client = container.http;
        const res = await client.get<{ data: PartyHit[] }>(`/api/parties/by-ids`, {
          params: { ids: value },
        });
        const row = res.data?.data?.[0];
        if (!cancelled && row) setSelected(row);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, selected?.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          const client = container.http;
          const res = await client.get<{ data: PartyHit[] }>(`/api/parties/search`, {
            params: { q: query.trim(), kind, limit: "30", status: "active" },
          });
          if (!cancelled) setHits(res.data?.data ?? []);
        } catch {
          if (!cancelled) setHits([]);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, kind]);

  const filtered = useMemo(() => hits, [hits]);
  const noMatch = query.trim().length > 0 && !loading && filtered.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-right text-sm font-medium hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
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
            placeholder={`ابحث عن ${entity} بالاسم أو الرمز...`}
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {loading && (
            <div className="px-3 py-3 text-xs text-muted-foreground">جاري البحث…</div>
          )}
          {!loading && filtered.length === 0 && !noMatch && (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              اكتب للبحث عن {entity}.
            </div>
          )}
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
                setSelected(p);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-secondary"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{p.name}</div>
                {p.code && (
                  <div className="truncate text-[11px] text-muted-foreground">{p.code}</div>
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
