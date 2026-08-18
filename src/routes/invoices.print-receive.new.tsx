import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Inbox, Printer, Save, Search } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { colorById, fabricById, rollById, useInventory } from "@/presentation/hooks/useInventory";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import { usePrintJobs, useOpenPrintJobs, useReceivePrint } from "@/presentation/hooks/usePrintJobs";
import { printDocument } from "@/components/print/printPortal";
import { PrintJobDocument } from "@/components/print/PrintJobDocument";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

type DocOption = { id: string; title: string; subtitle?: string };

/** Free-text type-ahead for picking a source document (roll / send voucher). */
function DocumentAutocomplete({
  selectedLabel,
  placeholder,
  options,
  onPick,
}: {
  selectedLabel: string;
  placeholder: string;
  options: DocOption[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    if (!q) return options.slice(0, 30);
    return options
      .filter((o) => `${o.title} ${o.subtitle ?? ""}`.toLowerCase().includes(q))
      .slice(0, 30);
  }, [q, options]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-right text-sm hover:border-primary focus:border-primary focus:outline-none",
            !selectedLabel && "text-muted-foreground",
          )}
        >
          <span className="truncate">{selectedLabel || placeholder}</span>
          <Search className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[320px] p-0" dir="rtl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث هنا..."
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-60 overflow-y-auto py-1">
          {list.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              لا توجد نتائج مطابقة
            </div>
          )}
          {list.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                onPick(o.id);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-right text-sm hover:bg-secondary"
            >
              <span className="truncate font-medium text-foreground">{o.title}</span>
              {o.subtitle && (
                <span className="truncate text-[11px] text-muted-foreground">{o.subtitle}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const Route = createFileRoute("/invoices/print-receive/new")({
  component: PrintReceivePage,
});

function PrintReceivePage() {
  useInventory();
  const { data: allJobs = [] } = usePrintJobs();
  const { data: open = [] } = useOpenPrintJobs();

  const receiveOptions = useMemo(
    () =>
      open.map((j) => {
        const f = fabricById(j.sourceFabricId);
        return {
          id: j.id,
          title: j.number,
          subtitle: `${f?.name ?? ""} — ${j.sentKg} كغ — ${j.pressName}`,
        };
      }),
    [open],
  );

  const [jobId, setJobId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [receivedKg, setReceivedKg] = useState<number | "">("");
  const [printCost, setPrintCost] = useState<number | "">("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("طباعة");
  const [newColorName, setNewColorName] = useState("");
  const [newColorCode, setNewColorCode] = useState("");
  const [newSalePrice, setNewSalePrice] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const receivePrint = useReceivePrint();

  const job = jobId ? allJobs.find((j) => j.id === jobId) : undefined;
  const src = job ? rollById(job.sourceRollId) : undefined;
  const srcFab = job ? fabricById(job.sourceFabricId) : undefined;
  const srcCol = job ? colorById(job.sourceColorId) : undefined;

  const srcCost = src?.pricePerKg ?? 0;
  const totalCost = srcCost + (Number(printCost) || 0);

  const reset = () => {
    setJobId("");
    setReceivedKg("");
    setPrintCost("");
    setNewName("");
    setNewColorName("");
    setNewColorCode("");
    setNewSalePrice("");
    setNotes("");
  };

  const save = async (thenPrint = false) => {
    setError(null);
    setOk(null);
    try {
      if (!jobId) throw new Error("اختر سند الإرسال");
      const q = Number(receivedKg);
      const c = Number(printCost);
      if (!q || q <= 0) throw new Error("أدخل الكمية المستلمة");
      if (isNaN(c) || c < 0) throw new Error("أدخل تكلفة الطباعة");
      if (!newName.trim()) throw new Error("أدخل اسم الصنف الجديد");
      const recRes = await receivePrint.mutateAsync({
        jobId,
        date,
        receivedKg: q,
        printCostPerKg: c,
        currency,
        newName,
        newCategory,
        newColorName,
        newColorCode,
        newSalePricePerKg: newSalePrice ? Number(newSalePrice) : undefined,
        notes,
      });
      if (!recRes.ok) throw new Error(recRes.error?.message ?? "فشل الحفظ");
      if (thenPrint) printDocument(<PrintJobDocument job={recRes.value} />);
      setOk(`تم استلام السند ${recRes.value.number} وإدخال الصنف الجديد إلى المخزون.`);
      reset();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const received = allJobs.filter((j) => j.status === "received").slice(0, 20);

  return (
    <AppShell
      title="استلام من المطبعة"
      subtitle="تحديد سند الإرسال وإدخال الصنف المطبوع الجديد مع تكلفة الطباعة."
    >
      <div className="space-y-4">
        <PageCard
          title="استلام سند"
          description="اختر سند الإرسال المفتوح، ثم عرّف الصنف الجديد."
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => save(true)}
                className="border-border bg-transparent text-foreground hover:bg-secondary"
              >
                <Printer className="ml-1 h-4 w-4" /> حفظ وطباعة
              </Button>
              <Button
                size="sm"
                onClick={() => save(false)}
                className="bg-primary text-primary-foreground hover:brightness-110"
              >
                <Save className="ml-1 h-4 w-4" /> حفظ
              </Button>
            </div>
          }
        >
          {error && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {ok && (
            <div className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
              {ok}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* SEND-VOUCHER */}
            <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <Inbox className="h-4 w-4 text-primary" />
                سند الإرسال
              </div>

              <Field label="اختر السند *">
                <DocumentAutocomplete
                  selectedLabel={job?.number ?? ""}
                  placeholder="ابحث برقم السند أو القماش أو المطبعة..."
                  options={receiveOptions}
                  onPick={setJobId}
                />
              </Field>

              <Field label="تاريخ الاستلام">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>

              {job && (
                <div className="rounded-md bg-background/40 px-3 py-2 text-[11px] text-muted-foreground space-y-1">
                  <div>
                    القماش الأصلي:{" "}
                    <span className="text-foreground">
                      {srcFab?.name} — {srcCol?.name}
                    </span>
                  </div>
                  <div>
                    المطبعة: <span className="text-foreground">{job.pressName}</span>
                  </div>
                  <div>
                    الكمية المرسلة:{" "}
                    <span className="tabular-nums text-foreground">{job.sentKg}</span> كغ
                  </div>
                  <div>
                    الأثواب المرسلة:{" "}
                    <span className="tabular-nums text-foreground">{job.pieces ?? 1}</span> أثواب
                  </div>
                  <div>
                    سيُضاف للمخزون:{" "}
                    <span className="tabular-nums text-foreground">
                      {receivedKg === "" ? "0" : formatQuantity(receivedKg)}
                    </span>{" "}
                    كغ
                  </div>
                  <div>
                    تكلفة الشراء الأصلية:{" "}
                    <span className="tabular-nums text-foreground">
                      {formatNumber(srcCost)} {src ? currencySymbol(src.currency) : ""}
                    </span>{" "}
                    / كغ
                  </div>
                </div>
              )}
            </div>

            {/* NEW ITEM */}
            <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                <Inbox className="h-4 w-4 -scale-x-100 text-primary" />
                الصنف المطبوع الجديد
              </div>

              <Field label="اسم التصميم / الصنف الجديد *">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مثال: قطن مطبوع — تصميم 12"
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="التصنيف">
                  <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
                </Field>
                <Field label="العملة">
                  <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SYP">ل.س</SelectItem>
                      <SelectItem value="USD">$ USD</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="اسم اللون">
                  <Input
                    value={newColorName}
                    onChange={(e) => setNewColorName(e.target.value)}
                    placeholder={srcCol?.name || ""}
                  />
                </Field>
                <Field label="كود اللون">
                  <Input
                    value={newColorCode}
                    onChange={(e) => setNewColorCode(e.target.value)}
                    placeholder="تلقائي"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="الكمية الفعلية المستلمة (كغ) *">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={receivedKg}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        setReceivedKg("");
                        return;
                      }
                      const n = Number(v);
                      if (Number.isFinite(n) && n >= 0) setReceivedKg(n);
                    }}
                    placeholder={job ? `حتى ${formatQuantity(job.sentKg)}` : ""}
                  />
                </Field>
                <Field label="تكلفة الطباعة للكيلو *">
                  <Input
                    type="number"
                    min={0}
                    value={printCost}
                    onChange={(e) =>
                      setPrintCost(e.target.value === "" ? "" : Number(e.target.value))
                    }
                  />
                </Field>
              </div>

              <Field label="سعر البيع للكيلو (اختياري)">
                <Input
                  type="number"
                  min={0}
                  value={newSalePrice}
                  onChange={(e) =>
                    setNewSalePrice(e.target.value === "" ? "" : Number(e.target.value))
                  }
                />
              </Field>

              <Field label="ملاحظات">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>

              {job && (
                <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
                  التكلفة الإجمالية للكيلو ={" "}
                  <span className="tabular-nums font-bold text-foreground">
                    {formatNumber(totalCost)}
                  </span>{" "}
                  (تكلفة القماش + الطباعة)
                </div>
              )}
            </div>
          </div>
        </PageCard>

        <PageCard title="آخر عمليات الاستلام" description={`إجمالي: ${received.length}`}>
          {received.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              لا توجد عمليات استلام بعد.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-right">الرقم</th>
                    <th className="p-2 text-right">تاريخ الاستلام</th>
                    <th className="p-2 text-right">المصدر</th>
                    <th className="p-2 text-right">الصنف الجديد</th>
                    <th className="p-2 text-right tabular-nums">مستلم (كغ)</th>
                    <th className="p-2 text-right tabular-nums">تكلفة الطباعة</th>
                  </tr>
                </thead>
                <tbody>
                  {received.map((j) => {
                    const f = fabricById(j.sourceFabricId);
                    const c = colorById(j.sourceColorId);
                    return (
                      <tr key={j.id} className="border-t border-border">
                        <td className="p-2 font-mono tabular-nums">{j.number}</td>
                        <td className="p-2 tabular-nums">{j.receivedDate}</td>
                        <td className="p-2">
                          {f?.name} — {c?.name}
                        </td>
                        <td className="p-2 font-medium text-foreground">{j.newName}</td>
                        <td className="p-2 tabular-nums">{j.receivedKg}</td>
                        <td className="p-2 tabular-nums">
                          {formatNumber(j.printCostPerKg ?? 0)}{" "}
                          {j.currency ? currencySymbol(j.currency as Currency) : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </PageCard>
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] font-semibold text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
