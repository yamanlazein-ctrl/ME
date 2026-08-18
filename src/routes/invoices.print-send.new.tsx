import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Send, Printer, Save, Search } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  colorById,
  fabricById,
  rollById,
  rolls,
  useInventory,
} from "@/presentation/hooks/useInventory";
import {
  usePrintJobs,
  useCreatePrintSend,
  nextPrintJobNumber,
} from "@/presentation/hooks/usePrintJobs";
import { printDocument } from "@/components/print/printPortal";
import { PrintJobDocument } from "@/components/print/PrintJobDocument";
import { formatQuantity } from "@/shared/utils/formatNumber";

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

export const Route = createFileRoute("/invoices/print-send/new")({
  component: PrintSendPage,
});

function PrintSendPage() {
  useInventory();
  const { data: jobs = [] } = usePrintJobs();
  const createPrintSend = useCreatePrintSend();
  const number = useMemo(() => nextPrintJobNumber(), []);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [fabricId, setFabricId] = useState("");
  const [fabricName, setFabricName] = useState("");
  const [colorId, setColorId] = useState("");
  const [colorName, setColorName] = useState("");
  const [rollId, setRollId] = useState("");
  const [quantityKg, setQuantityKg] = useState<number | "">("");
  const [pieces, setPieces] = useState<number | "">("");
  const [pressName, setPressName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const src = rollId ? rollById(rollId) : undefined;
  const srcFab = src ? fabricById(colorById(src.colorId)?.fabricId ?? "") : undefined;
  const srcCol = src ? colorById(src.colorId) : undefined;
  const selectedLabel = src
    ? `${srcFab?.name ?? ""} — ${srcCol?.name ?? ""} — صبغة ${src.rollNo}`
    : "";

  const sendOptions = useMemo(
    () =>
      rolls
        .filter((r) => r.remainingKg > 0)
        .map((r) => ({
          id: r.id,
          title: `${fabricById(colorById(r.colorId)?.fabricId ?? "")?.name ?? ""} — ${
            colorById(r.colorId)?.name ?? ""
          }`,
          subtitle: `صبغة ${r.rollNo} — متبقّي ${formatQuantity(r.remainingKg)} كغ — ${r.pieces} أثواب`,
        })),
    [rolls],
  );

  const q = Number(quantityKg);
  const qValid = Number.isFinite(q) && q >= 0;
  const pc = Number(pieces);
  const piecesValid = pieces === "" || (Number.isInteger(pc) && pc >= 0);
  const remainingAfter = src && qValid ? Math.max(0, src.remainingKg - q) : null;

  const pickRoll = (rid: string) => {
    const r = rollById(rid);
    const col = r ? colorById(r.colorId) : undefined;
    const fab = col ? fabricById(col.fabricId) : undefined;
    setRollId(rid);
    setFabricId(fab?.id ?? "");
    setFabricName(fab?.name ?? "");
    setColorId(col?.id ?? "");
    setColorName(col?.name ?? "");
    setQuantityKg("");
    setPieces("");
  };

  const reset = () => {
    setFabricId("");
    setFabricName("");
    setColorId("");
    setColorName("");
    setRollId("");
    setQuantityKg("");
    setPieces("");
    setPressName("");
    setNotes("");
  };

  const save = async (thenPrint = false) => {
    setError(null);
    setOk(null);
    try {
      const q = Number(quantityKg);
      if (!rollId) throw new Error("اختر المستند المصدر");
      if (!q || q <= 0) throw new Error("أدخل الكمية بالكيلو");
      if (!piecesValid) throw new Error("عدد الأثواب يجب أن يكون عدداً صحيحاً غير سالب");
      const recRes = await createPrintSend.mutateAsync({
        date,
        sourceRollId: rollId,
        quantityKg: q,
        pieces: pieces === "" ? undefined : pc,
        pressName,
        notes,
      });
      if (!recRes.ok) throw new Error(recRes.error?.message ?? "فشل الحفظ");
      if (thenPrint) printDocument(<PrintJobDocument job={recRes.value} />);
      setOk(`تم حفظ سند الإرسال ${recRes.value.number} بنجاح.`);
      reset();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openJobs = jobs.filter((j) => j.status === "sent");

  return (
    <AppShell
      title="إرسال إلى المطبعة"
      subtitle="خصم كمية من القماش الخام وتحويلها إلى حالة (قيد التشغيل في المطبعة)."
    >
      <div className="space-y-4">
        <PageCard
          title={`سند إرسال ${number}`}
          description="اختر القماش الخام والكمية واسم المطبعة."
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

          <div className="rounded-lg border border-border bg-secondary/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold text-foreground">
              <Send className="h-4 w-4 text-primary" />
              بيانات الإرسال
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="التاريخ">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="اسم المطبعة *">
                <Input
                  value={pressName}
                  onChange={(e) => setPressName(e.target.value)}
                  placeholder="مطبعة الشام / اسم المورد"
                />
              </Field>

              <div className="md:col-span-2">
                <Field label="المستند المصدر (القماش الخام) *">
                  <DocumentAutocomplete
                    selectedLabel={selectedLabel}
                    placeholder="ابحث بالاسم أو رقم الصبغة..."
                    options={sendOptions}
                    onPick={pickRoll}
                  />
                </Field>
                {src && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    المتاح: <span className="tabular-nums">{formatQuantity(src.remainingKg)}</span>{" "}
                    كغ — {src.pieces} أثواب
                  </p>
                )}
              </div>

              <div>
                <Field label="الكمية المرسلة (كغ) *">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={quantityKg}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        setQuantityKg("");
                        return;
                      }
                      const n = Number(v);
                      if (Number.isFinite(n) && n >= 0) setQuantityKg(n);
                    }}
                    placeholder={src ? `حد أقصى ${formatQuantity(src.remainingKg)}` : ""}
                  />
                </Field>
                {qValid && src && q > src.remainingKg && (
                  <p className="mt-1 text-[11px] text-destructive">
                    الكمية تتجاوز المتاح ({formatQuantity(src.remainingKg)} كغ)
                  </p>
                )}
              </div>

              <Field label="عدد الأثواب">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={pieces}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") {
                      setPieces("");
                      return;
                    }
                    const n = Math.floor(Number(v));
                    if (Number.isFinite(n) && n >= 0) setPieces(n);
                  }}
                  placeholder="0"
                />
              </Field>

              {remainingAfter !== null && (
                <div className="md:col-span-2 rounded-md border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
                  بعد الإرسال سيبقى في الصبغة:{" "}
                  <span className="tabular-nums font-bold text-foreground">
                    {formatQuantity(remainingAfter)}
                  </span>{" "}
                  كغ
                  <span className="mx-2 text-border">|</span>
                  أثواب الإرسال:{" "}
                  <span className="tabular-nums font-bold text-foreground">
                    {pieces === "" ? "0" : formatQuantity(pc)}
                  </span>
                </div>
              )}

              <Field label="ملاحظات">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="رقم التصميم، تعليمات…"
                />
              </Field>
            </div>
          </div>
        </PageCard>

        <PageCard title="سندات قيد التشغيل" description={`إجمالي المفتوح: ${openJobs.length}`}>
          {openJobs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              لا توجد سندات مفتوحة حالياً.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-right">الرقم</th>
                    <th className="p-2 text-right">التاريخ</th>
                    <th className="p-2 text-right">القماش المرسل</th>
                    <th className="p-2 text-right">المطبعة</th>
                    <th className="p-2 text-right tabular-nums">الكمية (كغ)</th>
                    <th className="p-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {openJobs.map((j) => {
                    const fab = fabricById(j.sourceFabricId);
                    const col = colorById(j.sourceColorId);
                    return (
                      <tr key={j.id} className="border-t border-border">
                        <td className="p-2 font-mono tabular-nums">{j.number}</td>
                        <td className="p-2 tabular-nums">{j.sentDate}</td>
                        <td className="p-2">
                          {fab?.name} — {col?.name}
                        </td>
                        <td className="p-2">{j.pressName}</td>
                        <td className="p-2 tabular-nums">{j.sentKg}</td>
                        <td className="p-2 text-left">
                          <Link
                            to="/invoices/print-receive/new"
                            className="text-primary hover:underline"
                          >
                            استلام
                          </Link>
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
