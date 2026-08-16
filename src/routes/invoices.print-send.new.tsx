import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Send, Printer, Save } from "lucide-react";
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
import {
  colorById,
  colorsOfFabric,
  fabricById,
  fabrics,
  rollById,
  rollsOfColor,
  useInventory,
} from "@/presentation/hooks/useInventory";
import {
  usePrintJobs,
  useCreatePrintSend,
  nextPrintJobNumber,
} from "@/presentation/hooks/usePrintJobs";
import { printDocument } from "@/components/print/printPortal";
import { PrintJobDocument } from "@/components/print/PrintJobDocument";
import { InlineFabricCell, InlineColorCell } from "@/components/invoices/InlineFabricCell";

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

  const availColors = fabricId ? colorsOfFabric(fabricId) : [];
  const availRolls = colorId ? rollsOfColor(colorId).filter((r) => r.remainingKg > 0) : [];
  const src = rollId ? rollById(rollId) : undefined;

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
      if (!rollId) throw new Error("اختر الصبغة المصدر");
      if (!q || q <= 0) throw new Error("أدخل الكمية بالكيلو");
      const recRes = await createPrintSend.mutateAsync({
        date,
        sourceRollId: rollId,
        quantityKg: q,
        pieces: pieces ? Number(pieces) : undefined,
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

              <Field label="القماش *">
                <InlineFabricCell
                  value={fabricName}
                  existingFabricId={fabricId || undefined}
                  onPickExisting={(fid) => {
                    setFabricId(fid);
                    setFabricName(fabricById(fid)?.name ?? "");
                    setColorId("");
                    setColorName("");
                    setRollId("");
                  }}
                  onSetName={(name) => {
                    setFabricName(name);
                    setFabricId("");
                    setColorId("");
                    setColorName("");
                    setRollId("");
                  }}
                />
              </Field>

              <Field label="اللون *">
                <InlineColorCell
                  fabricId={fabricId || undefined}
                  name={colorName}
                  code={colorById(colorId)?.code ?? ""}
                  existingColorId={colorId || undefined}
                  onPickExisting={(cid) => {
                    setColorId(cid);
                    setColorName(colorById(cid)?.name ?? "");
                    setRollId("");
                  }}
                  onSetName={(name) => {
                    setColorName(name);
                    setColorId("");
                    setRollId("");
                  }}
                  onSetCode={(code) => {}}
                />
              </Field>

              <Field label="الصبغة">
                <Select value={rollId} onValueChange={setRollId} disabled={!colorId}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصبغة" />
                  </SelectTrigger>
                  <SelectContent>
                    {availRolls.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        صبغة {r.rollNo} — {(r.pieces ?? 1)} أثوب — متبقّي {r.remainingKg} كغ
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="الكمية المرسلة (كغ) *">
                <Input
                  type="number"
                  min={0}
                  value={quantityKg}
                  onChange={(e) =>
                    setQuantityKg(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder={src ? `حد أقصى ${src.remainingKg}` : ""}
                />
              </Field>

              <Field label="عدد الأثواب">
                <Input
                  type="number"
                  min={1}
                  value={pieces}
                  onChange={(e) =>
                    setPieces(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder="1"
                />
              </Field>

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
