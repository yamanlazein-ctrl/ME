import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { addSupplier, supplierById, suppliers } from "@/presentation/hooks/useParties";

/**
 * Compact supplier picker for use in the invoice header.
 * - Type to search existing suppliers.
 * - If no match, an inline quick-add form appears (name + phone + notes).
 * - Saving quick-add registers the supplier in the global list AND selects it
 *   for the current invoice — no navigation off the page.
 *
 * Wraps `addSupplier` from mock-inventory (same registration path used by the
 * Suppliers page and by PartyPicker).
 */
export function SupplierInlineCombobox({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addMode, setAddMode] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const selected = value ? supplierById(value) : undefined;
  const q = query.trim().toLowerCase();
  const list = useMemo(
    () => (q ? suppliers.filter((s) => s.name.toLowerCase().includes(q)) : suppliers),
    [q],
  );
  const noMatch = q.length > 0 && list.length === 0;

  const openAdd = () => {
    setName(query.trim());
    setPhone("");
    setNotes("");
    setAddMode(true);
  };

  const commitAdd = async () => {
    if (!name.trim()) return;
    try {
      const created = await addSupplier({
        name: name.trim(),
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        currency: "SYP",
        status: "active",
      });
      onChange(created.id);
      setAddMode(false);
      setQuery("");
      setOpen(false);
    } catch {
      // addSupplier already surfaces the error via toast.
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setAddMode(false);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-right text-sm font-medium hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary",
            !selected && "text-muted-foreground font-normal",
            className,
          )}
        >
          <span className="truncate">{selected?.name ?? "اختر المورد"}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0" dir="rtl">
        {!addMode ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث أو اكتب اسم مورد جديد..."
                className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && noMatch) {
                    e.preventDefault();
                    openAdd();
                  }
                }}
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    onChange(s.id);
                    setQuery("");
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-right text-sm hover:bg-secondary"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{s.name}</div>
                    {s.phone && (
                      <div
                        dir="ltr"
                        className="truncate text-right text-[11px] text-muted-foreground tabular-nums"
                      >
                        {s.phone}
                      </div>
                    )}
                  </div>
                  {s.id === value && <Check className="h-4 w-4 text-primary" />}
                </button>
              ))}
              {noMatch && (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  لا يوجد مورد بهذا الاسم.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={openAdd}
              className="flex w-full items-center gap-2 border-t border-border bg-primary/5 px-3 py-2.5 text-right text-sm font-semibold text-primary hover:bg-primary/10"
            >
              <Plus className="h-4 w-4" />
              {q ? `إضافة "${q}" كمورد جديد` : "إضافة مورد جديد"}
            </button>
          </>
        ) : (
          <div className="space-y-2 p-3">
            <div>
              <Label className="text-[11px] font-semibold">اسم المورد *</Label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[11px] font-semibold">الهاتف</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-9"
                dir="ltr"
              />
            </div>
            <div>
              <Label className="text-[11px] font-semibold">ملاحظات</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-9" />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAddMode(false)}>
                إلغاء
              </Button>
              <Button
                size="sm"
                onClick={commitAdd}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                حفظ وتحديد
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
