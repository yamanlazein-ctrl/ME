import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber, formatQuantity, formatMoney } from "@/shared/utils/formatNumber";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { customers, suppliers } from "@/presentation/hooks/useParties";
import {
  rolls,
  rollById,
  colorById,
  fabricById,
  type Currency,
} from "@/presentation/hooks/useInventory";
import { CURRENCIES, formatAmount } from "@/presentation/hooks/useCurrency";
import { useCreateReturn, RETURN_REASONS, type ReturnKind, type ReturnReason } from "@/presentation/hooks/useReturns";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { Plus, Save, Trash2, X, Lock } from "lucide-react";

type Line = { id: string; rollId: string; quantityKg: number; pricePerKg: number };

export function ReturnForm({ kind }: { kind: ReturnKind }) {
  const navigate = useNavigate();
  const parties = kind === "entry" ? suppliers : customers;
  const [partyId, setPartyId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState<ReturnReason>("defect");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [lines, setLines] = useState<Line[]>([]);
  const [notesPrint, setNotesPrint] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data: invoicesData } = useInvoicesList();
  const allInvoices = invoicesData?.data ?? [];

  const invoiceOptions = useMemo(() => {
    if (!partyId) return [];
    const wanted = kind === "entry" ? "entry" : "sale";
    return allInvoices.filter((i) => i.type === wanted && i.status !== "cancelled" && i.partyId === partyId);
  }, [partyId, kind, allInvoices]);

  const addLine = () =>
    setLines((l) => [...l, { id: `l-${Date.now()}`, rollId: "", quantityKg: 0, pricePerKg: 0 }]);
  const update = (id: string, patch: Partial<Line>) =>
    setLines((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id: string) => setLines((l) => l.filter((x) => x.id !== id));

  const totalAmount = lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);

  const createReturnMut = useCreateReturn();

  const save = async () => {
    setErr(null);
    if (!partyId) return setErr("اختر الطرف.");
    const valid = lines.filter((l) => l.rollId && l.quantityKg > 0);
    if (!valid.length) return setErr("أضف بنداً واحداً على الأقل.");
    for (const l of valid) {
      const r = rollById(l.rollId);
      if (kind === "entry" && r && l.quantityKg > r.remainingKg) {
        return setErr(`الكمية تتجاوز المتاح في الصبغة #${r.rollNo}.`);
      }
    }
    await createReturnMut.mutateAsync({
      kind,
      date,
      partyId,
      originalInvoiceId: invoiceId || undefined,
      lines: valid.map((l) => ({
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pricePerKg: l.pricePerKg,
      })),
      reason,
      currency,
      notesPrint: notesPrint || undefined,
      notesInternal: notesInternal || undefined,
    });
    navigate({ to: "/returns" });
  };

  return (
    <>
      <PageCard title="بيانات المرتجع">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={kind === "entry" ? "المورد *" : "العميل *"}>
            <Select
              value={partyId}
              onValueChange={(v) => {
                setPartyId(v);
                setInvoiceId("");
              }}
            >
              <SelectTrigger className="!h-11">
                <SelectValue placeholder="اختر..." />
              </SelectTrigger>
              <SelectContent>
                {parties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="الفاتورة الأصلية (اختياري)">
            <Select
              value={invoiceId || "none"}
              onValueChange={(v) => setInvoiceId(v === "none" ? "" : v)}
              disabled={!partyId}
            >
              <SelectTrigger className="!h-11">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— بدون فاتورة —</SelectItem>
                {invoiceOptions.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="التاريخ">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-11"
            />
          </Field>
          <Field label="السبب">
            <Select value={reason} onValueChange={(v) => setReason(v as ReturnReason)}>
              <SelectTrigger className="!h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETURN_REASONS.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="العملة">
            <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
              <SelectTrigger className="!h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </PageCard>

      <PageCard
        title="بنود المرتجع"
        description="اختر الصبغة والكمية المرتجعة (بالكغ)."
        actions={
          <Button onClick={addLine} variant="outline">
            <Plus className="h-4 w-4 ml-1" /> إضافة بند
          </Button>
        }
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[700px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الصبغة</th>
                <th>المتبقي</th>
                <th className="text-left">الكمية</th>
                <th className="text-left">السعر / كغ</th>
                <th className="text-left">الإجمالي</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l) => {
                const r = rollById(l.rollId);
                const c = r && colorById(r.colorId);
                const f = c && fabricById(c.fabricId);
                return (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      <Select
                        value={l.rollId}
                        onValueChange={(v) => {
                          const rr = rollById(v);
                          update(l.id, { rollId: v, pricePerKg: rr?.pricePerKg ?? 0 });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="اختر صبغة" />
                        </SelectTrigger>
                        <SelectContent>
                          {rolls.map((rr) => {
                            const cc = colorById(rr.colorId);
                            const ff = cc && fabricById(cc.fabricId);
                            return (
                              <SelectItem key={rr.id} value={rr.id}>
                                {ff?.name} — {cc?.name} #{rr.rollNo}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {f && (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {f.name} — {c?.name}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {r?.remainingKg ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-left">
                      <Input
                        type="number"
                        step="0.01"
                        value={l.quantityKg || ""}
                        onChange={(e) => update(l.id, { quantityKg: Number(e.target.value) })}
                        className="h-9 w-24"
                      />
                    </td>
                    <td className="px-3 py-2 text-left">
                      <Input
                        type="number"
                        step="0.01"
                        value={l.pricePerKg || ""}
                        onChange={(e) => update(l.id, { pricePerKg: Number(e.target.value) })}
                        className="h-9 w-28"
                      />
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums font-semibold">
                      {formatNumber(l.quantityKg * l.pricePerKg)}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => remove(l.id)} className="text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    لا بنود بعد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border p-3 text-left text-sm">
          الإجمالي:{" "}
          <span className="font-bold tabular-nums text-lg">
            {formatAmount(totalAmount, currency)}
          </span>
        </div>
      </PageCard>

      <PageCard title="الملاحظات">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">ملاحظات (تُطبع)</Label>
            <Textarea rows={3} value={notesPrint} onChange={(e) => setNotesPrint(e.target.value)} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" /> ملاحظات داخلية
            </Label>
            <Textarea
              rows={3}
              value={notesInternal}
              onChange={(e) => setNotesInternal(e.target.value)}
              className="bg-secondary/40"
            />
          </div>
        </div>
      </PageCard>

      {err && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => history.back()}>
            <X className="h-4 w-4 ml-1" /> إلغاء
          </Button>
          <Button onClick={save} className="bg-primary text-primary-foreground">
            <Save className="h-4 w-4 ml-1" /> حفظ المرتجع
          </Button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
