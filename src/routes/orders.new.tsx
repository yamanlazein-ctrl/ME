import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus, Trash2, UserPlus, ClipboardList } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { DocumentFooter } from "@/components/layout/DocumentFooter";
import { InlineFabricCell, InlineColorCell } from "@/components/invoices/InlineFabricCell";
import { fabricById, colorById, useInventory } from "@/presentation/hooks/useInventory";
import { addCustomer, customers, customerById } from "@/presentation/hooks/useParties";
import type { Currency } from "@/domain/types";
import { useCreateOrder } from "@/presentation/hooks/useOrders";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/orders/new")({
  component: NewOrderPage,
  head: () => ({
    meta: [
      { title: "طلب جديد — أقمشة الشام" },
      { name: "description", content: "تسجيل طلب زبون للأقمشة غير المتوفرة حالياً." },
    ],
  }),
});

type Line = {
  id: string;
  fabricId: string;
  fabricName: string;
  colorId: string;
  colorName: string;
  colorCode: string;
  requestedKg: number;
  pieces: number;
  widthCm?: number;
  weightGsm?: number;
  notes?: string;
};

let seq = 0;
const emptyLine = (): Line => ({
  id: `ol-${++seq}`,
  fabricId: "",
  fabricName: "",
  colorId: "",
  colorName: "",
  colorCode: "",
  requestedKg: 0,
  pieces: 1,
});

const cloneSticky = (p: Line): Partial<Line> => ({
  fabricId: p.fabricId,
  fabricName: p.fabricName,
  colorId: p.colorId,
  colorName: p.colorName,
  colorCode: p.colorCode,
  widthCm: p.widthCm,
  weightGsm: p.weightGsm,
});

const hasData = (l: Line) => l.fabricName.trim() !== "" || l.requestedKg > 0;

function NewOrderPage() {
  useInventory();
  const navigate = useNavigate();
  const createOrder = useCreateOrder();

  const [customerId, setCustomerId] = useState("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [quickCustomer, setQuickCustomer] = useState(false);

  const fabricRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const dataLines = lines.filter(hasData);

  const updateLine = (id: string, patch: Partial<Line>) =>
    setLines((p) => p.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const removeLine = (id: string) =>
    setLines((p) => {
      const next = p.filter((x) => x.id !== id);
      return next.length === 0 ? [emptyLine()] : next;
    });

  const appendRowAndFocus = () => {
    const rows = lines.filter(hasData);
    const last = rows[rows.length - 1];
    const row: Line = last ? { ...emptyLine(), ...cloneSticky(last) } : emptyLine();
    setLines((p) => [...p, row]);
    setTimeout(() => fabricRefs.current[row.id]?.focus(), 0);
  };

  const pickFabric = (id: string, fabricId: string) => {
    const f = fabricById(fabricId);
    if (!f) return;
    updateLine(id, {
      fabricId: f.id,
      fabricName: f.name,
      colorId: "",
      colorName: "",
      colorCode: "",
    });
  };
  const pickColor = (id: string, colorId: string) => {
    const c = colorById(colorId);
    if (!c) return;
    updateLine(id, { colorId: c.id, colorName: c.name, colorCode: c.code });
  };

  const save = async () => {
    setError(null);
    if (!customerId) return setError("يرجى تحديد العميل.");
    const valid = lines.filter(
      (l) => l.fabricName.trim() && l.colorName.trim() && l.requestedKg > 0 && l.pieces >= 1,
    );
    if (!valid.length) return setError("أضف على الأقل بنداً واحداً كاملاً.");
    const cust = customerById(customerId);
    try {
      const o = await createOrder.mutateAsync({
        customerId,
        customerNameSnapshot: cust?.name ?? "",
        customerPhoneSnapshot: cust?.phone,
        date,
        notes,
        currency,
        items: valid.map((l) => ({
          fabricId: l.fabricId || undefined,
          fabricName: l.fabricName.trim(),
          colorId: l.colorId || undefined,
          colorName: l.colorName.trim(),
          colorCode: l.colorCode || undefined,
          requestedKg: l.requestedKg,
          pieces: l.pieces,
          widthCm: l.widthCm,
          weightGsm: l.weightGsm,
          notes: l.notes,
        })),
      });
      navigate({ to: "/orders/$id", params: { id: o.id } });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1400px] space-y-3 pb-24">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <ClipboardList className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground">طلب جديد</h1>
            <p className="text-[11px] text-muted-foreground">
              سجّل طلب الزبون — تُنبَّه تلقائياً عند دخول قماش مطابق للمخزون.
            </p>
          </div>
        </div>

        {/* Items first */}
        <PageCard
          title="بنود الطلب"
          description="اختر القماش واللون والكمية المطلوبة لكل سطر"
          actions={
            <Button size="sm" onClick={appendRowAndFocus} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> إضافة بند
            </Button>
          }
        >
          <div className="space-y-3">
            {lines.map((l, i) => {
              const rowIsEmpty = !hasData(l);
              return (
                <article
                  key={l.id}
                  className={cn(
                    "rounded-lg border bg-background/60 transition",
                    rowIsEmpty
                      ? "border-dashed border-primary/30 bg-primary/[0.02]"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "grid h-6 min-w-[28px] place-items-center rounded-md px-2 text-[11px] font-bold tabular-nums",
                          rowIsEmpty
                            ? "bg-primary/10 text-primary"
                            : "bg-primary text-primary-foreground",
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        البند {i + 1}
                        {!rowIsEmpty && l.fabricName && (
                          <span className="mr-1.5 font-normal text-muted-foreground">
                            — {l.fabricName}
                            {l.colorName && ` / ${l.colorName}`}
                          </span>
                        )}
                      </span>
                    </div>
                    {!rowIsEmpty && (
                      <button
                        type="button"
                        onClick={() => removeLine(l.id)}
                        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                        aria-label="حذف البند"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 gap-2 p-3 md:grid-cols-4">
                    <Field label="نوع القماش *">
                      <InlineFabricCell
                        ref={(el) => {
                          fabricRefs.current[l.id] = el;
                        }}
                        value={l.fabricName}
                        existingFabricId={l.fabricId || undefined}
                        onPickExisting={(fid) => pickFabric(l.id, fid)}
                        onSetName={(name) =>
                          updateLine(l.id, {
                            fabricName: name,
                            fabricId: "",
                            colorId: "",
                            colorName: "",
                            colorCode: "",
                          })
                        }
                      />
                    </Field>
                    <Field label="اللون *">
                      <InlineColorCell
                        fabricId={l.fabricId || undefined}
                        name={l.colorName}
                        code={l.colorCode}
                        existingColorId={l.colorId || undefined}
                        onPickExisting={(cid) => pickColor(l.id, cid)}
                        onSetName={(name) => updateLine(l.id, { colorName: name, colorId: "" })}
                        onSetCode={(code) => updateLine(l.id, { colorCode: code, colorId: "" })}
                      />
                    </Field>
                    <Field label="الكمية المطلوبة (كغ) *">
                      <Input
                        type="number"
                        className="h-9 tabular-nums"
                        value={l.requestedKg || ""}
                        onChange={(e) =>
                          updateLine(l.id, {
                            requestedKg: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                          if (e.key === "Enter" && lines[lines.length - 1]?.id === l.id) {
                            e.preventDefault();
                            appendRowAndFocus();
                          }
                        }}
                        placeholder="0"
                      />
                    </Field>
                    <Field label="عدد الأثواب *">
                      <Input
                        type="number"
                        className="h-9 tabular-nums"
                        value={l.pieces || ""}
                        onChange={(e) =>
                          updateLine(l.id, {
                            pieces: e.target.value === "" ? 1 : Math.max(1, Number(e.target.value)),
                          })
                        }
                        placeholder="1"
                        min={1}
                      />
                    </Field>
                    <Field label="ملاحظة السطر">
                      <Input
                        className="h-9"
                        value={l.notes ?? ""}
                        onChange={(e) => updateLine(l.id, { notes: e.target.value })}
                        placeholder="—"
                      />
                    </Field>
                    <Field label="العرض (سم)">
                      <Input
                        type="number"
                        className="h-9 tabular-nums"
                        value={l.widthCm ?? ""}
                        onChange={(e) =>
                          updateLine(l.id, {
                            widthCm: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="الغراماج (غ/م²)">
                      <Input
                        type="number"
                        className="h-9 tabular-nums"
                        value={l.weightGsm ?? ""}
                        onChange={(e) =>
                          updateLine(l.id, {
                            weightGsm: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                </article>
              );
            })}

            <button
              type="button"
              onClick={appendRowAndFocus}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs font-semibold text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Plus className="h-4 w-4" />
              إضافة بند جديد
            </button>
          </div>
        </PageCard>

        {/* Customer & meta */}
        <PageCard title="بيانات الزبون والطلب" description="اختر الزبون أو أضف واحداً سريعاً">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="الزبون *">
              <div className="flex gap-1">
                <div className="min-w-0 flex-1">
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger className="!h-9">
                      <SelectValue placeholder="اختر الزبون" />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 shrink-0 px-2"
                  onClick={() => setQuickCustomer(true)}
                  title="زبون جديد سريع"
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
              </div>
            </Field>
            <Field label="التاريخ">
              <Input
                type="date"
                className="h-9 tabular-nums"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="العملة المتوقعة">
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger className="!h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س</SelectItem>
                  <SelectItem value="USD">$ USD</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="ملاحظات">
              <Input
                className="h-9"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="—"
              />
            </Field>
          </div>
        </PageCard>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive">
            {error}
          </div>
        )}
      </div>

      <DocumentFooter
        onSave={save}
        onCancel={() => history.back()}
        saveLabel="حفظ الطلب"
        extra={
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {dataLines.length} بند
          </span>
        }
      />

      <QuickCustomerDialog
        open={quickCustomer}
        onClose={() => setQuickCustomer(false)}
        onCreated={(id) => {
          setCustomerId(id);
          setQuickCustomer(false);
        }}
      />
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function QuickCustomerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return setErr("الاسم مطلوب");
    try {
      const c = await addCustomer({ name: name.trim(), phone: phone.trim() });
      onCreated(c.id);
      setName("");
      setPhone("");
      setErr(null);
    } catch {
      // addCustomer already surfaces the error via toast.
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>زبون جديد سريع</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div>
            <Label className="text-xs">الاسم *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
          </div>
          <div>
            <Label className="text-xs">الهاتف</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" />
          </div>
          {err && <div className="text-xs text-destructive">{err}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit}>حفظ</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
