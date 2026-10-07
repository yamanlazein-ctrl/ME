import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { addSupplier, supplierById, suppliers, useParties } from "@/presentation/hooks/useParties";
import { recentSuggestions } from "@/shared/utils/suggestions";
import { findSupplierByExactName } from "@/shared/utils/supplierMatch";

/**
 * Compact supplier picker for the purchase-invoice header.
 * Exact-name matches surface the existing supplier for one-click select —
 * never push the operator to a save-time unique-name error.
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
  const partiesVersion = useParties();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addMode, setAddMode] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [dupHint, setDupHint] = useState<{ id: string; name: string; phone?: string | null } | null>(
    null,
  );

  const selected = value ? supplierById(value) : undefined;
  const q = query.trim().toLowerCase();
  const list = q
    ? suppliers.filter((s) => s.name.toLowerCase().includes(q))
    : recentSuggestions(suppliers);
  const noMatch = q.length > 0 && list.length === 0;

  // Bug #1: the duplicate check is the shared domain rule (src/shared/utils/
  // supplierMatch.ts), so the combobox and its tests cannot drift apart.
  const exactExisting = useMemo(
    () => findSupplierByExactName(suppliers, addMode ? name : query),
    [addMode, name, query, partiesVersion],
  );

  const openAdd = () => {
    const draft = query.trim();
    const hit = findSupplierByExactName(suppliers, draft);
    if (hit) {
      setDupHint({ id: hit.id, name: hit.name, phone: hit.phone });
      setName(draft);
      setAddMode(true);
      return;
    }
    setDupHint(null);
    setName(draft);
    setPhone("");
    setNotes("");
    setAddMode(true);
  };

  const selectExisting = (id: string) => {
    onChange(id);
    setDupHint(null);
    setAddMode(false);
    setQuery("");
    setOpen(false);
  };

  const commitAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const hit = findSupplierByExactName(suppliers, trimmed);
    if (hit) {
      setDupHint({ id: hit.id, name: hit.name, phone: hit.phone });
      return;
    }
    try {
      const created = await addSupplier({
        name: trimmed,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        currency: "SYP",
        status: "active",
      });
      onChange(created.id);
      setDupHint(null);
      setAddMode(false);
      setQuery("");
      setOpen(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/مستخدم مسبق|مكرر|duplicate|unique/i.test(msg)) {
        const again =
          suppliers.find((s) => s.name.trim().toLowerCase() === trimmed.toLowerCase()) ?? null;
        if (again) {
          setDupHint({ id: again.id, name: again.name, phone: again.phone });
          return;
        }
      }
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
          setDupHint(null);
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
                  if (e.key === "Enter" && exactExisting) {
                    e.preventDefault();
                    selectExisting(exactExisting.id);
                    return;
                  }
                  if (e.key === "Enter" && noMatch) {
                    e.preventDefault();
                    openAdd();
                  }
                }}
              />
            </div>
            {exactExisting && (
              <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                <div className="font-semibold text-amber-900 dark:text-amber-200">
                  المورد «{exactExisting.name}» موجود مسبقاً
                </div>
                <button
                  type="button"
                  className="mt-1 font-semibold text-primary hover:underline"
                  onClick={() => selectExisting(exactExisting.id)}
                >
                  اختيار المورد الموجود
                </button>
              </div>
            )}
            <div className="max-h-56 overflow-y-auto py-1">
              {!q && list.length === 0 && (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  لا يوجد موردون بعد، أضف مورداً جديداً.
                </div>
              )}
              {list.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => selectExisting(s.id)}
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
              {noMatch && !exactExisting && (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  لا يوجد مورد بهذا الاسم.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={openAdd}
              disabled={Boolean(exactExisting)}
              className="flex w-full items-center gap-2 border-t border-border bg-primary/5 px-3 py-2.5 text-right text-sm font-semibold text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {exactExisting
                ? "لا يمكن إنشاء مورد مكرر — اختر الموجود"
                : q
                  ? `إضافة "${q}" كمورد جديد`
                  : "إضافة مورد جديد"}
            </button>
          </>
        ) : (
          <div className="space-y-2 p-3">
            {dupHint && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                <div className="font-semibold text-amber-900 dark:text-amber-200">
                  المورد «{dupHint.name}» موجود مسبقاً — لا يمكن إنشاء اسم مكرر.
                </div>
                {dupHint.phone && (
                  <div className="mt-0.5 text-muted-foreground tabular-nums" dir="ltr">
                    {dupHint.phone}
                  </div>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="mt-2 h-8 w-full"
                  onClick={() => selectExisting(dupHint.id)}
                >
                  اختيار المورد الموجود
                </Button>
              </div>
            )}
            <div>
              <Label className="text-[11px] font-semibold">اسم المورد *</Label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => {
                  const v = e.target.value;
                  setName(v);
                  const hit = suppliers.find(
                    (s) => s.name.trim().toLowerCase() === v.trim().toLowerCase(),
                  );
                  setDupHint(hit ? { id: hit.id, name: hit.name, phone: hit.phone } : null);
                }}
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
                disabled={Boolean(dupHint)}
              />
            </div>
            <div>
              <Label className="text-[11px] font-semibold">ملاحظات</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="h-9"
                disabled={Boolean(dupHint)}
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setAddMode(false)}>
                إلغاء
              </Button>
              <Button
                size="sm"
                onClick={() => void commitAdd()}
                disabled={Boolean(dupHint)}
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
