import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Inbox, Palette, Plus, Printer, Save, Search, Trash2 } from "lucide-react";
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
import { printOrArchive } from "@/components/print/printPortal";
import { archiveMeta } from "@/shared/utils/documentArchive";
import { PrintJobDocument } from "@/components/print/PrintJobDocument";
import { PrintPageBreak } from "@/components/print/PrintDocument";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

type DocOption = { id: string; title: string; subtitle?: string };

/** One line of the receive request — one sent voucher becoming one new color. */
type ReceiveLine = {
  key: string;
  /** Sent-job id, or `fabric:<sourceFabricId>` marker pre-filtering the picker. */
  jobId: string;
  receivedKg: number | "";
  printCostPerKg: number | "";
  newName: string;
  newColorName: string;
  newColorCode: string;
  newSalePrice: number | "";
};

const emptyReceiveLine = (): ReceiveLine => ({
  key: `rl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  jobId: "",
  receivedKg: "",
  printCostPerKg: "",
  newName: "",
  newColorName: "",
  newColorCode: "",
  newSalePrice: "",
});

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
  const receivePrint = useReceivePrint();

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [newCategory, setNewCategory] = useState("طباعة");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ReceiveLine[]>([emptyReceiveLine()]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const jobById = (id: string) => allJobs.find((j) => j.id === id);

  const updateLine = (key: string, patch: Partial<ReceiveLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((ls) => (ls.length === 1 ? [emptyReceiveLine()] : ls.filter((l) => l.key !== key)));

  /** "Add another color for the same fabric": appends a receive line
   *  pre-filtered to open jobs of the same source fabric. */
  const addColorForSameFabric = (line: ReceiveLine) => {
    const job = jobById(line.jobId);
    if (!job) return;
    setLines((ls) => [...ls, { ...emptyReceiveLine(), jobId: `fabric:${job.sourceFabricId}` }]);
  };

  const openOptions = useMemo(
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

  const optionsForLine = (line: ReceiveLine): DocOption[] => {
    if (line.jobId.startsWith("fabric:")) {
      const fabId = line.jobId.slice(7);
      return openOptions.filter((o) => {
        const j = jobById(o.id);
        return j && j.sourceFabricId === fabId;
      });
    }
    return openOptions;
  };

  const labelForLine = (line: ReceiveLine): string => {
    if (line.jobId.startsWith("fabric:")) {
      const fab = fabricById(line.jobId.slice(7));
      return fab ? `قماش ${fab.name} — اختر سند الإرسال` : "";
    }
    const job = jobById(line.jobId);
    if (!job) return "";
    const f = fabricById(job.sourceFabricId);
    return `${job.number} — ${f?.name ?? ""} — ${job.sentKg} كغ`;
  };

  const received = allJobs.filter((j) => j.status === "received").slice(0, 20);

  /** Manual FX needed for non-USD receive, or when converting a non-USD source into USD. */
  const needsManualFx = useMemo(() => {
    if (currency !== "USD") return true;
    return lines.some((l) => {
      if (!l.jobId || l.jobId.startsWith("fabric:")) return false;
      const job = jobById(l.jobId);
      const src = job ? rollById(job.sourceRollId) : undefined;
      const srcCur = src?.currency ?? "SYP";
      return srcCur !== currency;
    });
  }, [currency, lines, allJobs]);

  const save = async (thenPrint = false) => {
    setError(null);
    setOk(null);
    const valid = lines.filter(
      (l) => !l.jobId.startsWith("fabric:") && l.jobId && Number(l.receivedKg) > 0 && l.newName.trim(),
    );
    try {
      if (valid.length === 0)
        throw new Error("أضف بنداً واحداً على الأقل (سند إرسال + كمية + اسم الصنف الجديد)");
      for (const l of valid) {
        const c = Number(l.printCostPerKg);
        if (isNaN(c) || c < 0) throw new Error("أدخل تكلفة طباعة صحيحة لكل بند");
      }
      if (!newCategory.trim()) throw new Error("أدخل التصنيف");
      if (needsManualFx && !(Number(exchangeRate) > 0)) {
        const proceed = window.confirm(
          "عملة الاستلام تختلف عن المصدر أو ليست بالدولار، ولم يُدخل سعر صرف.\n\nموافق = المتابعة بدون تحويل (تكلفة المصدر كما هي)\nإلغاء = الرجوع لإدخال سعر الصرف يدوياً",
        );
        if (!proceed) {
          setError("أدخل سعر الصرف يدوياً ثم أعد الحفظ.");
          return;
        }
      }

      // One composite request → one receive per sent voucher, sequentially.
      const created = [];
      for (const l of valid) {
        const recRes = await receivePrint.mutateAsync({
          jobId: l.jobId,
          date,
          receivedKg: Number(l.receivedKg),
          printCostPerKg: Number(l.printCostPerKg),
          currency,
          ...(needsManualFx && Number(exchangeRate) > 0
            ? { exchangeRate: Number(exchangeRate) }
            : {}),
          newName: l.newName.trim(),
          newCategory,
          newColorName: l.newColorName.trim() || undefined,
          newColorCode: l.newColorCode.trim() || undefined,
          newSalePricePerKg: l.newSalePrice === "" ? undefined : Number(l.newSalePrice),
          notes,
        });
        if (!recRes.ok) throw new Error(recRes.error?.message ?? "فشل الحفظ");
        created.push(recRes.value);
      }

      const numbers = created.map((j) => j.number).join("، ");
      const doc = (
        <>
          {created.map((j, i) => (
            <div key={j.id}>
              {i > 0 && <PrintPageBreak />}
              <PrintJobDocument job={j} />
            </div>
          ))}
        </>
      );
      if (created.length > 0) {
        printOrArchive(
          doc,
          archiveMeta("print_receive", {
            date,
            typeLabel: "PRINT-RECV",
            number: created.map((j) => j.number).join("_"),
          }),
          thenPrint,
        );
      }
      setOk(
        created.length === 1
          ? `تم استلام السند ${numbers} وإدخال الصنف الجديد إلى المخزون.`
          : `تم استلام ${created.length} سنادات بنجاح: ${numbers}`,
      );
      setLines([emptyReceiveLine()]);
      setNotes("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <AppShell
      title="استلام من المطبعة"
      subtitle="تحديد سنادات الإرسال وإدخال الأصناف المطبوعة الجديدة بألوانها — بأي عدد من الألوان."
    >
      <div className="space-y-4">
        <PageCard
          title="استلام سنادات"
          description="لكل بند: سند إرسال + الصنف الجديد — البنود تُستلم دفعة واحدة بنفس التاريخ والعملة."
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

          {/* Shared fields */}
          <div className="mb-4 grid gap-3 rounded-lg border border-border bg-secondary/40 p-4 md:grid-cols-4">
            <Field label="تاريخ الاستلام">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="التصنيف">
              <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
            </Field>
            <Field label="العملة">
              <Select
                value={currency}
                onValueChange={(v) => {
                  const c = v as Currency;
                  setCurrency(c);
                  if (c === "USD") setExchangeRate("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س</SelectItem>
                  <SelectItem value="USD">$ USD</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="سعر الصرف (ل.س / $)">
              {!needsManualFx ? (
                <Input
                  value="1"
                  readOnly
                  disabled
                  dir="ltr"
                  className="bg-muted/40 text-muted-foreground"
                />
              ) : (
                <Input
                  type="number"
                  min={1}
                  step="any"
                  value={exchangeRate}
                  onChange={(e) =>
                    setExchangeRate(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder="أدخل سعر الصرف يدوياً"
                  dir="ltr"
                />
              )}
            </Field>
          </div>

          {/* ── Receive lines ── */}
          <div className="space-y-3">
            {lines.map((line, idx) => {
              const isFabricOnly = line.jobId.startsWith("fabric:");
              const job = isFabricOnly ? undefined : jobById(line.jobId);
              const src = job ? rollById(job.sourceRollId) : undefined;
              const srcFab = job ? fabricById(job.sourceFabricId) : undefined;
              const srcCol = job ? colorById(job.sourceColorId) : undefined;
              const srcCost = src?.pricePerKg ?? 0;
              const totalCost = srcCost + (Number(line.printCostPerKg) || 0);
              return (
                <div key={line.key} className="rounded-lg border border-border bg-background/50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-6 min-w-[28px] place-items-center rounded-md bg-primary/10 px-2 text-[11px] font-bold text-primary tabular-nums">
                        {idx + 1}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        {job
                          ? `${job.number} — ${srcFab?.name ?? ""} — ${srcCol?.name ?? ""}`
                          : "لون مُستلم"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {job && (
                        <button
                          type="button"
                          onClick={() => addColorForSameFabric(line)}
                          className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary transition hover:bg-primary/20"
                          title={`إضافة لون آخر لقماش ${srcFab?.name ?? ""}`}
                        >
                          <Palette className="h-3.5 w-3.5" /> إضافة لون آخر لنفس القماش
                        </button>
                      )}
                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                          aria-label="حذف البند"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="md:col-span-2">
                      <Field label="سند الإرسال *">
                        <DocumentAutocomplete
                          selectedLabel={labelForLine(line)}
                          placeholder="ابحث برقم السند أو القماش أو المطبعة..."
                          options={optionsForLine(line)}
                          onPick={(id) => updateLine(line.key, { jobId: id })}
                        />
                      </Field>
                    </div>
                    <Field label="اسم التصميم / الصنف الجديد *">
                      <Input
                        value={line.newName}
                        onChange={(e) => updateLine(line.key, { newName: e.target.value })}
                        placeholder="مثال: قطن مطبوع — تصميم 12"
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="اسم اللون">
                        <Input
                          value={line.newColorName}
                          onChange={(e) => updateLine(line.key, { newColorName: e.target.value })}
                          placeholder={srcCol?.name || ""}
                        />
                      </Field>
                      <Field label="كود اللون">
                        <Input
                          value={line.newColorCode}
                          onChange={(e) => updateLine(line.key, { newColorCode: e.target.value })}
                          placeholder="تلقائي"
                        />
                      </Field>
                    </div>

                    <Field label="الكمية الفعلية المستلمة (كغ) *">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.01}
                        value={line.receivedKg}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "") return updateLine(line.key, { receivedKg: "" });
                          const n = Number(v);
                          if (Number.isFinite(n) && n >= 0) updateLine(line.key, { receivedKg: n });
                        }}
                        placeholder={job ? `حتى ${formatQuantity(job.sentKg)}` : ""}
                      />
                    </Field>
                    <Field label="تكلفة الطباعة للكيلو *">
                      <Input
                        type="number"
                        min={0}
                        value={line.printCostPerKg}
                        onChange={(e) =>
                          updateLine(line.key, {
                            printCostPerKg: e.target.value === "" ? "" : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="سعر البيع للكيلو (اختياري)">
                      <Input
                        type="number"
                        min={0}
                        value={line.newSalePrice}
                        onChange={(e) =>
                          updateLine(line.key, {
                            newSalePrice: e.target.value === "" ? "" : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    {job && (
                      <div className="flex items-end">
                        <div className="w-full rounded-md border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
                          التكلفة الإجمالية للكيلو ={" "}
                          <span className="font-bold tabular-nums text-foreground">
                            {formatNumber(totalCost)}
                          </span>{" "}
                          (تكلفة القماش + الطباعة)
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => setLines((ls) => [...ls, emptyReceiveLine()])}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs font-semibold text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Plus className="h-4 w-4" /> إضافة بند استلام آخر (أي قماش)
            </button>

            <Field label="ملاحظات">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
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
