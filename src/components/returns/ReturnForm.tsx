import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber } from "@/shared/utils/formatNumber";
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
import { FormattedAmountInput } from "@/components/invoices/InvoiceFormLayout";
import { PartyCombobox } from "@/components/vouchers/PartyCombobox";
import { RollSearchCombobox } from "@/components/returns/RollSearchCombobox";
import { useParties } from "@/presentation/hooks/useParties";
import {
  rolls,
  rollById,
  colorById,
  fabricById,
  useInventory,
  type Currency,
} from "@/presentation/hooks/useInventory";
import { CURRENCIES, formatAmount } from "@/presentation/hooks/useCurrency";
import {
  useCreateReturn,
  RETURN_REASONS,
  type ReturnKind,
  type ReturnReason,
} from "@/presentation/hooks/useReturns";
import { useInvoicesList, useInvoice } from "@/presentation/hooks/useInvoices";
import { Plus, Palette, Save, Trash2, X, Lock } from "lucide-react";

type Line = {
  id: string;
  rollId: string;
  quantityKg: number;
  pricePerKg: number;
  pieces: number;
  fabricId?: string;
};

/** Fixed column tracks so headers and cells stay aligned (RTL). */
const LINE_GRID =
  "grid grid-cols-[minmax(0,2.2fr)_4.5rem_5.5rem_4.5rem_6rem_5rem_2.5rem] items-center gap-x-2";

export function ReturnForm({ kind }: { kind: ReturnKind }) {
  useParties();
  useInventory();
  const navigate = useNavigate();
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

  const { data: originalInvoice } = useInvoice(invoiceId);
  const invoiceRollIds = useMemo(() => {
    const invLines = originalInvoice?.lines ?? [];
    return new Set(invLines.map((ln) => ln.rollId).filter(Boolean));
  }, [originalInvoice]);

  const invoicePriceByRoll = useMemo(() => {
    const invLines = originalInvoice?.lines ?? [];
    const map = new Map<string, number>();
    for (const ln of invLines) {
      if (ln.rollId && !map.has(ln.rollId)) map.set(ln.rollId, ln.pricePerKg);
    }
    return map;
  }, [originalInvoice]);

  const invoiceOptions = useMemo(() => {
    if (!partyId) return [];
    const wanted = kind === "entry" ? "entry" : "sale";
    return allInvoices.filter(
      (i) => i.type === wanted && i.status !== "cancelled" && i.partyId === partyId,
    );
  }, [partyId, kind, allInvoices]);

  const addLine = () =>
    setLines((l) => [
      ...l,
      { id: `l-${Date.now()}`, rollId: "", quantityKg: 0, pricePerKg: 0, pieces: 1 },
    ]);
  const update = (id: string, patch: Partial<Line>) => {
    setErr(null);
    setLines((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };
  const remove = (id: string) => {
    setErr(null);
    setLines((l) => l.filter((x) => x.id !== id));
  };

  const addColorForSameFabric = (lineId: string) => {
    const currentLine = lines.find((l) => l.id === lineId);
    let fabricId = currentLine?.fabricId;
    if (!fabricId && currentLine?.rollId) {
      const r = rollById(currentLine.rollId);
      const c = r && colorById(r.colorId);
      fabricId = c?.fabricId;
    }
    const idx = lines.findIndex((l) => l.id === lineId);
    const newLine: Line = {
      id: `l-${Date.now()}`,
      rollId: "",
      quantityKg: 0,
      pricePerKg: 0,
      pieces: 1,
      fabricId,
    };
    setLines((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, newLine);
      return next;
    });
  };

  const poolForLine = (l: Line) => {
    let pool = l.fabricId
      ? rolls.filter((rr) => colorById(rr.colorId)?.fabricId === l.fabricId)
      : rolls;
    if (invoiceId && invoiceRollIds.size > 0) {
      pool = pool.filter((rr) => invoiceRollIds.has(rr.id));
    }
    return pool;
  };

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
        pieces: l.pieces,
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
      <PageCard title="بيانات المرتجع" description="الطرف والفاتورة الأصلية أولاً، ثم التاريخ والسبب والعملة.">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={kind === "entry" ? "المورد *" : "العميل *"}>
              <PartyCombobox
                kind={kind === "entry" ? "supplier" : "customer"}
                value={partyId}
                onChange={(id) => {
                  setPartyId(id);
                  setInvoiceId("");
                }}
                onCreateNew={() =>
                  navigate({ to: kind === "entry" ? "/suppliers" : "/customers" })
                }
                placeholder={kind === "entry" ? "ابحث عن مورد..." : "ابحث عن عميل..."}
              />
            </Field>
            <Field label="الفاتورة الأصلية (اختياري)">
              <Select
                value={invoiceId || "none"}
                onValueChange={(v) => setInvoiceId(v === "none" ? "" : v)}
                disabled={!partyId}
              >
                <SelectTrigger className="!h-9">
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
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="التاريخ">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9"
              />
            </Field>
            <Field label="السبب">
              <Select value={reason} onValueChange={(v) => setReason(v as ReturnReason)}>
                <SelectTrigger className="!h-9">
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
                <SelectTrigger className="!h-9">
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
        </div>
      </PageCard>

      <PageCard
        title="بنود المرتجع"
        description="ابحث عن الصبغة بالاسم أو الرقم، ثم أدخل الكمية."
        actions={
          <Button onClick={addLine} variant="outline" size="sm">
            <Plus className="h-4 w-4 ml-1" /> إضافة بند
          </Button>
        }
        noBodyPadding
      >
        <div className="min-w-0 overflow-x-auto">
          <div className="min-w-[720px]">
            <div
              className={`${LINE_GRID} border-b border-border bg-secondary/60 px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground`}
            >
              <div>الصبغة</div>
              <div className="text-center">المتبقي</div>
              <div className="text-center">الكمية</div>
              <div className="text-center">الأثواب</div>
              <div className="text-center">السعر / كغ</div>
              <div className="text-center">الإجمالي</div>
              <div />
            </div>

            {lines.length === 0 && (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                لا بنود بعد — اضغط «إضافة بند».
              </div>
            )}

            <div className="divide-y divide-border">
              {lines.map((l) => {
                const r = rollById(l.rollId);
                const c = r && colorById(r.colorId);
                const f = c && fabricById(c.fabricId);
                const lineTotal = l.quantityKg * l.pricePerKg;
                return (
                  <div key={l.id} className="px-3 py-2.5">
                    <div className={LINE_GRID}>
                      <div className="min-w-0">
                        <RollSearchCombobox
                          value={l.rollId}
                          options={poolForLine(l)}
                          placeholder={
                            l.fabricId ? "صبغة أخرى لنفس القماش..." : "ابحث عن صبغة..."
                          }
                          onChange={(v) => {
                            const rr = rollById(v);
                            const cc = rr && colorById(rr.colorId);
                            const defaultPrice =
                              invoicePriceByRoll.get(v) ?? rr?.pricePerKg ?? 0;
                            update(l.id, {
                              rollId: v,
                              pricePerKg: defaultPrice,
                              fabricId: cc?.fabricId,
                            });
                          }}
                        />
                        {l.rollId && f && (
                          <button
                            type="button"
                            onClick={() => addColorForSameFabric(l.id)}
                            className="mt-1.5 inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-bold text-primary hover:bg-primary/15"
                            title={`إضافة لون آخر لـ ${f.name}`}
                            aria-label="إضافة لون آخر لنفس القماش"
                          >
                            <Palette className="h-3 w-3" />
                            + لون آخر لنفس القماش
                          </button>
                        )}
                      </div>
                      <div className="text-center text-sm tabular-nums text-muted-foreground">
                        {r ? formatNumber(r.remainingKg) : "—"}
                      </div>
                      <div>
                        <FormattedAmountInput
                          value={l.quantityKg || ""}
                          onChange={(v) => update(l.id, { quantityKg: v === "" ? 0 : v })}
                          className="h-9 w-full text-center"
                          ariaLabel="الكمية"
                        />
                      </div>
                      <div>
                        <Input
                          type="number"
                          min="1"
                          value={l.pieces || ""}
                          onChange={(e) =>
                            update(l.id, {
                              pieces: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                          className="h-9 w-full text-center tabular-nums"
                          aria-label="عدد الأثواب"
                        />
                      </div>
                      <div>
                        <FormattedAmountInput
                          value={l.pricePerKg || ""}
                          onChange={(v) => update(l.id, { pricePerKg: v === "" ? 0 : v })}
                          className="h-9 w-full text-center"
                          ariaLabel="السعر"
                        />
                      </div>
                      <div className="text-center text-sm font-semibold tabular-nums">
                        {formatNumber(lineTotal)}
                      </div>
                      <div className="flex justify-center">
                        <button
                          type="button"
                          onClick={() => remove(l.id)}
                          className="grid h-8 w-8 place-items-center rounded-md text-destructive hover:bg-destructive/10"
                          aria-label="حذف البند"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="border-t border-border p-3 text-left text-sm">
          الإجمالي:{" "}
          <span className="text-lg font-bold tabular-nums">
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
    <div className="space-y-1.5">
      <Label className="mb-0 block text-[11px] font-semibold leading-none text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
