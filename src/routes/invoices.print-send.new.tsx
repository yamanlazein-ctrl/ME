import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Palette, Plus, Send, Printer, Save, Search, Trash2 } from "lucide-react";
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
import { usePrintJobs, useCreatePrintSend } from "@/presentation/hooks/usePrintJobs";
import { useNextInvoiceNumber } from "@/presentation/hooks/useInvoices";
import { printOrArchive } from "@/components/print/printPortal";
import { archiveMeta } from "@/shared/utils/documentArchive";
import { PrintJobDocument } from "@/components/print/PrintJobDocument";
import { PrintPageBreak } from "@/components/print/PrintDocument";
import { formatQuantity } from "@/shared/utils/formatNumber";
import { DEFAULT_SUGGESTION_COUNT } from "@/shared/utils/suggestions";

type DocOption = { id: string; title: string; subtitle?: string };

/** One line of the send request — a single raw-fabric lot (= one color). */
type SendLine = {
  key: string;
  rollId: string;
  quantityKg: number | "";
  pieces: number | "";
};

const emptySendLine = (): SendLine => ({
  key: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  rollId: "",
  quantityKg: "",
  pieces: "",
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
    if (!q) return options.slice(0, DEFAULT_SUGGESTION_COUNT);
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
  const invVersion = useInventory();
  const { data: jobs = [] } = usePrintJobs();
  const createPrintSend = useCreatePrintSend();
  // Server-side read-only preview of the next PRT number (estimate; the real
  // number is allocated inside the save transaction).
  const { data: previewNumber } = useNextInvoiceNumber("print");
  const number = previewNumber ?? "…";

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<SendLine[]>([emptySendLine()]);
  const [pressName, setPressName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const lineOf = (rid: string) => rollById(rid);
  const fabricOfLine = (rid: string) => {
    const r = lineOf(rid);
    return r ? fabricById(colorById(r.colorId)?.fabricId ?? "") : undefined;
  };
  const colorOfLine = (rid: string) => {
    const r = lineOf(rid);
    return r ? colorById(r.colorId) : undefined;
  };

  const sendOptions = useMemo(
    () =>
      rolls
        .filter((r) => r.remainingKg > 0)
        .map((r) => ({
          id: r.id,
          title: `${fabricById(colorById(r.colorId)?.fabricId ?? "")?.name ?? ""} — ${
            colorById(r.colorId)?.name ?? ""
          }`,
          subtitle: `صبغة ${r.rollNo} — متبقّي ${formatQuantity(r.remainingKg)} كغ — ${r.remainingPieces ?? r.pieces} أثواب`,
        })),
    [invVersion],
  );

  const updateLine = (key: string, patch: Partial<SendLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((ls) => (ls.length === 1 ? [emptySendLine()] : ls.filter((l) => l.key !== key)));

  /** "Add another color for the same fabric": appends a line pre-filtered to
   *  the source line's fabric — mirrors the invoices multi-color flow. */
  const addColorForSameFabric = (line: SendLine) => {
    const fab = fabricOfLine(line.rollId);
    if (!fab) return;
    setLines((ls) => [...ls, { ...emptySendLine(), rollId: `fabric:${fab.id}` }]);
  };
  /** Lines carrying `fabric:<id>` resolve their options to that fabric's lots. */
  const optionsForLine = (line: SendLine): DocOption[] => {
    if (line.rollId.startsWith("fabric:")) {
      const fabId = line.rollId.slice(7);
      return sendOptions.filter((o) => {
        const r = rollById(o.id);
        return r && colorById(r.colorId)?.fabricId === fabId;
      });
    }
    return sendOptions;
  };
  const labelForLine = (line: SendLine): string => {
    if (line.rollId.startsWith("fabric:")) {
      const fab = fabricById(line.rollId.slice(7));
      return fab ? `قماش ${fab.name} — اختر اللون/الصبغة` : "";
    }
    const r = lineOf(line.rollId);
    if (!r) return "";
    return `${fabricOfLine(r.id)?.name ?? ""} — ${colorOfLine(r.id)?.name ?? ""} — صبغة ${r.rollNo}`;
  };
  const pickRoll = (key: string, rid: string) => {
    const r = rollById(rid);
    updateLine(key, { rollId: rid, quantityKg: "", pieces: "" });
    void r;
  };

  const openJobs = jobs.filter((j) => j.status === "sent");

  const save = async (thenPrint = false) => {
    setError(null);
    setOk(null);
    const valid = lines.filter(
      (l) => !l.rollId.startsWith("fabric:") && l.rollId && Number(l.quantityKg) > 0,
    );
    try {
      if (valid.length === 0) throw new Error("أضف بنداً واحداً على الأقل (لفافة + كمية)");
      for (const l of valid) {
        const src = rollById(l.rollId);
        const q = Number(l.quantityKg);
        if (!src) throw new Error("المستند المصدر غير صالح");
        if (q > src.remainingKg)
          throw new Error(
            `الكمية تتجاوز المتاح في الصبغة #${src.rollNo} (${formatQuantity(src.remainingKg)} كغ)`,
          );
        const pc = l.pieces === "" ? undefined : Number(l.pieces);
        if (pc !== undefined && (!Number.isInteger(pc) || pc < 0))
          throw new Error("عدد الأثواب يجب أن يكون عدداً صحيحاً غير سالب");
      }
      if (!pressName.trim()) throw new Error("أدخل اسم المطبعة");

      // One composite request → one send-voucher per color (lot), sequentially.
      const created = [];
      for (const l of valid) {
        const recRes = await createPrintSend.mutateAsync({
          date,
          sourceRollId: l.rollId,
          quantityKg: Number(l.quantityKg),
          pieces: l.pieces === "" ? undefined : Number(l.pieces),
          pressName,
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
          archiveMeta("print_send", {
            date,
            typeLabel: "PRINT-SEND",
            number: created.map((j) => j.number).join("_"),
          }),
          thenPrint,
        );
      }
      setOk(
        created.length === 1
          ? `تم حفظ سند الإرسال ${numbers} بنجاح.`
          : `تم حفظ ${created.length} سنادات إرسال بنجاح: ${numbers}`,
      );
      setLines([emptySendLine()]);
      setPressName("");
      setNotes("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <AppShell
      title="إرسال إلى المطبعة"
      subtitle="خصم كمية من القماش الخام وتحويلها إلى حالة (قيد التشغيل في المطبعة) — بأي عدد من الألوان."
    >
      <div className="space-y-4">
        <PageCard
          title={`سند إرسال ${number}`}
          description="اختر لكل لون لفافته وكميته — البنود تنشأ كسندات مرتبطة بنفس المطبعة والتاريخ."
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

            <div className="mb-4 grid gap-3 md:grid-cols-2">
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
            </div>

            {/* ── Color lines ── */}
            <div className="space-y-3">
              {lines.map((line, idx) => {
                const isFabricOnly = line.rollId.startsWith("fabric:");
                const src = isFabricOnly ? undefined : rollById(line.rollId);
                const q = Number(line.quantityKg);
                const qValid = Number.isFinite(q) && q >= 0;
                const pc = line.pieces === "" ? 0 : Number(line.pieces);
                const piecesValid = line.pieces === "" || (Number.isInteger(pc) && pc >= 0);
                const remainingAfter = src && qValid ? Math.max(0, src.remainingKg - q) : null;
                const fab = src ? fabricById(colorById(src.colorId)?.fabricId ?? "") : undefined;
                return (
                  <div
                    key={line.key}
                    className="rounded-lg border border-border bg-background/50 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 min-w-[28px] place-items-center rounded-md bg-primary/10 px-2 text-[11px] font-bold text-primary tabular-nums">
                          {idx + 1}
                        </span>
                        <span className="text-xs font-semibold text-foreground">
                          {fab
                            ? `${fab.name} — ${colorOfLine(src?.id ?? "")?.name ?? ""}`
                            : "لون / صبغة"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {src && (
                          <button
                            type="button"
                            onClick={() => addColorForSameFabric(line)}
                            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-bold text-primary transition hover:bg-primary/20"
                            title={`إضافة لون آخر لقماش ${fab?.name ?? ""}`}
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

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="md:col-span-1">
                        <Field label="المستند المصدر (اللون) *">
                          <DocumentAutocomplete
                            selectedLabel={labelForLine(line)}
                            placeholder="ابحث بالاسم أو رقم الصبغة..."
                            options={optionsForLine(line)}
                            onPick={(rid) => pickRoll(line.key, rid)}
                          />
                        </Field>
                        {src && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            المتاح:{" "}
                            <span className="tabular-nums">{formatQuantity(src.remainingKg)}</span>{" "}
                            كغ — {src.remainingPieces ?? src.pieces} أثواب
                          </p>
                        )}
                      </div>

                      <Field label="الكمية المرسلة (كغ) *">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.01}
                          value={line.quantityKg}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "") return updateLine(line.key, { quantityKg: "" });
                            const n = Number(v);
                            if (Number.isFinite(n) && n >= 0)
                              updateLine(line.key, { quantityKg: n });
                          }}
                          placeholder={src ? `حد أقصى ${formatQuantity(src.remainingKg)}` : ""}
                        />
                        {qValid && src && q > src.remainingKg && (
                          <p className="mt-1 text-[11px] text-destructive">
                            الكمية تتجاوز المتاح ({formatQuantity(src.remainingKg)} كغ)
                          </p>
                        )}
                      </Field>

                      <Field label="عدد الأثواب">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          step={1}
                          value={line.pieces}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "") return updateLine(line.key, { pieces: "" });
                            const n = Math.floor(Number(v));
                            if (Number.isFinite(n) && n >= 0) updateLine(line.key, { pieces: n });
                          }}
                          placeholder="0"
                        />
                        {!piecesValid && (
                          <p className="mt-1 text-[11px] text-destructive">عدد غير صالح</p>
                        )}
                      </Field>
                    </div>

                    {remainingAfter !== null && (
                      <div className="mt-2 rounded-md border border-border bg-background/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                        بعد الإرسال سيبقى في الصبغة:{" "}
                        <span className="font-bold tabular-nums text-foreground">
                          {formatQuantity(remainingAfter)}
                        </span>{" "}
                        كغ
                        <span className="mx-2 text-border">|</span>
                        أثواب الإرسال:{" "}
                        <span className="font-bold tabular-nums text-foreground">
                          {line.pieces === "" ? "0" : formatQuantity(pc)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => setLines((ls) => [...ls, emptySendLine()])}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs font-semibold text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
              >
                <Plus className="h-4 w-4" /> إضافة لون آخر (أي قماش)
              </button>
            </div>

            <div className="mt-4">
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

        <PageCard
          title="سجل كميات الإرسال"
          description={`كل عمليات الإرسال (الأحدث أولاً) — ${jobs.length} سند`}
        >
          {jobs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">لا سجل بعد.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-secondary/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-right">الرقم</th>
                    <th className="p-2 text-right">تاريخ الإرسال</th>
                    <th className="p-2 text-right">القماش</th>
                    <th className="p-2 text-right">المطبعة</th>
                    <th className="p-2 text-right tabular-nums">مرسل (كغ)</th>
                    <th className="p-2 text-right tabular-nums">مستلم (كغ)</th>
                    <th className="p-2 text-right">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
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
                        <td className="p-2 tabular-nums font-semibold">{j.sentKg}</td>
                        <td className="p-2 tabular-nums">{j.receivedKg ?? "—"}</td>
                        <td className="p-2">{j.status === "received" ? "مستلم" : "قيد التشغيل"}</td>
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
