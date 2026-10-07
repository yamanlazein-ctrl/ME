import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ColorSwatch } from "@/components/common/ColorSwatch";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  addColor,
  addFabric,
  addRoll,
  fabricById,
  updateColor,
  updateFabric,
  updateRoll,
  type Color,
  type Currency,
  type Fabric,
  type Roll,
  adjustRoll,
} from "@/presentation/hooks/useInventory";
import { addSupplier, suppliers, supplierById, useParties } from "@/presentation/hooks/useParties";
import { SectionCard, Field } from "./InventoryHelpers";

import { localToday } from "@/lib/localDate";
type FabricFormState = { open: boolean; editing?: Fabric };
type ColorFormState = { open: boolean; fabricId: string; editing?: Color };
type RollFormState = { open: boolean; colorId: string; editing?: Roll };

/** Keep decimal text as typed (supports 0.50 / 0,50) — Number()-on-change drops "0.". */
function parseDecimalInput(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function FabricFormDialog({ state, onClose }: { state: FabricFormState; onClose: () => void }) {
  useParties();
  const editing = state.editing;

  // Section 1
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState<"meter" | "yard" | "kg">("kg");
  const [minKg, setMinKg] = useState<number>(10);
  // Section 2
  const [supplierId, setSupplierId] = useState<string>("");
  const [entryDate, setEntryDate] = useState<string>(localToday());
  const [createdBy, setCreatedBy] = useState<string>("أحمد الشامي");
  // Section 3
  const [colorName, setColorName] = useState("");
  const [colorCode, setColorCode] = useState("");
  // Section 4
  const [dyeBatch, setDyeBatch] = useState("");
  const [widthCm, setWidthCm] = useState("");
  const [weightGsm, setWeightGsm] = useState("");
  const [qty, setQty] = useState("");
  const [pieces, setPieces] = useState("1");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  // Section 5
  const [notes, setNotes] = useState("");
  const [imageUrl, setImageUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [catErr, setCatErr] = useState<string | null>(null);

  useEffect(() => {
    if (!state.open) return;
    const e = state.editing;
    setName(e?.name ?? "");
    setCategory(e?.category ?? "");
    setUnit(e?.unit ?? "kg");
    setMinKg(e?.minStockKg ?? 10);
    setSupplierId("");
    setEntryDate(localToday());
    setCreatedBy(e?.createdBy ?? "أحمد الشامي");
    setColorName("");
    setColorCode("");
    setDyeBatch("");
    setWidthCm("");
    setWeightGsm("");
    setQty("");
    setPieces("1");
    setPurchasePrice("");
    setSalePrice("");
    setCurrency("SYP");
    setNotes(e?.notes ?? "");
    setImageUrl(e?.imageUrl ?? "");
    setError(null);
  }, [state.open, state.editing]);

  const onImagePick = (file: File | undefined) => {
    if (!file) return;
    void toSmallDataUrl(file).then(setImageUrl);
  };

  const submit = async () => {
    setError(null);
    setNameErr(null);
    setCatErr(null);
    let valid = true;
    if (!name.trim()) {
      setNameErr("اسم القماش مطلوب.");
      valid = false;
    }
    if (!category.trim()) {
      setCatErr("الفئة مطلوبة.");
      valid = false;
    }
    if (!valid) return;
    try {
      if (editing) {
        await updateFabric(editing.id, {
          name,
          category,
          unit,
          minStockKg: Number(minKg) || 0,
          notes,
          imageUrl,
        });
        onClose();
        return;
      }
      const fab = await addFabric({
        name,
        category,
        unit,
        minStockKg: Number(minKg) || 0,
        notes,
        imageUrl,
      });
      if (colorName.trim() && colorCode.trim()) {
        const col = await addColor({ fabricId: fab.id, name: colorName, code: colorCode });
        const qNum = parseDecimalInput(qty) ?? 0;
        const purchaseNum = parseDecimalInput(purchasePrice);
        const saleNum = parseDecimalInput(salePrice);
        const widthNum = parseDecimalInput(widthCm);
        const gsmNum = parseDecimalInput(weightGsm);
        if (dyeBatch.trim() && qNum > 0 && supplierId && purchaseNum != null && purchaseNum > 0) {
          await addRoll({
            colorId: col.id,
            rollNo: `${Date.now()}`.slice(-4),
            dyeBatch,
            initialKg: qNum,
            pieces: Math.max(1, Math.trunc(Number(pieces) || 1)),
            pricePerKg: purchaseNum,
            salePricePerKg: saleNum != null && saleNum > 0 ? saleNum : undefined,
            currency,
            supplierId,
            entryDate,
            widthCm: widthNum != null && widthNum > 0 ? widthNum : undefined,
            weightGsm: gsmNum != null && gsmNum > 0 ? gsmNum : undefined,
          });
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر الحفظ.");
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="!max-w-[960px] w-[calc(100vw-2rem)] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden"
      >
        <DialogHeader className="px-6 py-4 border-b border-border shrink-0">
          <DialogTitle className="text-base">
            {editing ? "تعديل قماش" : "إضافة قماش جديد"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing
              ? "عدّل بيانات القماش الأساسية. الألوان والكميات تُحرَّر من بطاقة القماش."
              : "عرّف جميع بيانات القماش، اللون، الصبغة الأولى، والمورد."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-6 bg-secondary/20">
          <SectionCard index={1} title="المعلومات الأساسية" desc="تعريف القماش وفئته ووحدة القياس.">
            <Field label="اسم القماش" required error={nameErr ?? undefined}>
              <Input
                className="h-10"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameErr(null);
                }}
                placeholder="مثال: قطن مصري"
              />
            </Field>
            <Field label="الفئة" required error={catErr ?? undefined}>
              <Input
                className="h-10"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setCatErr(null);
                }}
                placeholder="قطن / شيفون / ساتان"
              />
            </Field>
            <Field label="وحدة القياس" required>
              <Select value={unit} onValueChange={(v) => setUnit(v as "meter" | "yard" | "kg")}>
                <SelectTrigger className="!h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meter">متر</SelectItem>
                  <SelectItem value="yard">يارد</SelectItem>
                  <SelectItem value="kg">كيلو</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="الحد الأدنى للمخزون (كغ)">
              <Input
                className="h-10"
                type="number"
                value={minKg}
                onChange={(e) => setMinKg(Number(e.target.value) || 0)}
              />
            </Field>
          </SectionCard>

          {!editing && (
            <>
              <SectionCard
                index={2}
                title="بيانات المورد"
                desc="المورد وتاريخ الإدخال والمستخدم المسؤول."
              >
                <Field label="المورد">
                  <Select value={supplierId} onValueChange={setSupplierId}>
                    <SelectTrigger className="!h-10">
                      <SelectValue placeholder="ابحث واختر مورداً" />
                    </SelectTrigger>
                    <SelectContent>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="تاريخ الإدخال">
                  <Input
                    className="h-10"
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                  />
                </Field>
                <Field label="الشخص الذي قام بالإضافة" full>
                  <Select value={createdBy} onValueChange={setCreatedBy}>
                    <SelectTrigger className="!h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="أحمد الشامي">أحمد الشامي</SelectItem>
                      <SelectItem value="محمد الحلبي">محمد الحلبي</SelectItem>
                      <SelectItem value="خالد الأحمد">خالد الأحمد</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </SectionCard>

              <SectionCard index={3} title="بيانات اللون" desc="اسم اللون ورقمه — حقلان منفصلان.">
                <Field label="اسم اللون">
                  <Input
                    className="h-10"
                    value={colorName}
                    onChange={(e) => setColorName(e.target.value)}
                    placeholder="مثال: أزرق سماوي"
                  />
                </Field>
                <Field label="رقم اللون">
                  <Input
                    className="h-10 tabular-nums"
                    value={colorCode}
                    onChange={(e) => setColorCode(e.target.value)}
                    placeholder="C-014"
                  />
                </Field>
              </SectionCard>

              <SectionCard
                index={4}
                title="بيانات الصبغة"
                desc="الصبغة الأولى الواردة مع هذا القماش (اختياري)."
              >
                <Field label="رقم الصبغة">
                  <Input
                    className="h-10"
                    value={dyeBatch}
                    onChange={(e) => setDyeBatch(e.target.value)}
                    placeholder="D-8801"
                  />
                </Field>
                <Field label="العرض (سم)">
                  <Input
                    className="h-10"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={widthCm}
                    onChange={(e) => setWidthCm(e.target.value)}
                  />
                </Field>
                <Field label="الكثافة / الوزن (غ/م²)">
                  <Input
                    className="h-10"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={weightGsm}
                    onChange={(e) => setWeightGsm(e.target.value)}
                  />
                </Field>
                <Field label="الكمية (كغ)">
                  <Input
                    className="h-10"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                  />
                </Field>
                <Field label="عدد الأثواب">
                  <Input
                    className="h-10"
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="1"
                    value={pieces}
                    onChange={(e) => setPieces(e.target.value)}
                  />
                </Field>
                <Field label="سعر الشراء / كغ">
                  <div className="flex gap-2">
                    <Input
                      className="h-10 flex-1"
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      value={purchasePrice}
                      onChange={(e) => setPurchasePrice(e.target.value)}
                    />
                    <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                      <SelectTrigger className="!h-10 w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SYP">ل.س</SelectItem>
                        <SelectItem value="USD">$</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </Field>
                <Field label="سعر البيع / كغ">
                  <Input
                    className="h-10"
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={salePrice}
                    onChange={(e) => setSalePrice(e.target.value)}
                  />
                </Field>
              </SectionCard>
            </>
          )}

          <SectionCard index={5} title="حقول إضافية" desc="ملاحظات وصورة القماش.">
            <Field label="ملاحظات" full>
              <Textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="أي ملاحظات إضافية عن هذا القماش..."
              />
            </Field>
            <Field label="صورة القماش (اختياري)" full>
              <div className="flex items-center gap-4">
                <div className="grid h-24 w-24 shrink-0 place-items-center rounded-lg border border-dashed border-border bg-background overflow-hidden">
                  {imageUrl ? (
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-muted-foreground">لا صورة</span>
                  )}
                </div>
                <div className="flex-1">
                  <input
                    id="fabric-image"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onImagePick(e.target.files?.[0])}
                  />
                  <label
                    htmlFor="fabric-image"
                    className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium hover:bg-secondary"
                  >
                    <Plus className="h-4 w-4" /> اختر صورة
                  </label>
                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => setImageUrl("")}
                      className="mr-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      إزالة
                    </button>
                  )}
                </div>
              </div>
            </Field>
          </SectionCard>

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="sticky bottom-0 border-t border-border bg-card px-6 py-4 flex-row-reverse gap-2">
          <Button
            onClick={submit}
            className="h-11 min-w-[160px] bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {editing ? "حفظ التعديلات" : "إضافة القماش"}
          </Button>
          <Button variant="outline" className="h-11 min-w-[100px]" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ColorFormDialog({ state, onClose }: { state: ColorFormState; onClose: () => void }) {
  const editing = state.editing;
  const [name, setName] = useState(editing?.name ?? "");
  const [code, setCode] = useState(editing?.code ?? "");
  const [hex, setHex] = useState<string | undefined>(editing?.hex ?? undefined);
  const [imageUrl, setImageUrl] = useState<string | undefined>(editing?.imageUrl ?? undefined);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.open) {
      setName(state.editing?.name ?? "");
      setCode(state.editing?.code ?? "");
      setHex(state.editing?.hex ?? undefined);
      setImageUrl(state.editing?.imageUrl ?? undefined);
    }
  }, [state.open, state.editing]);

  const fabric = fabricById(state.fabricId);

  const onFile = (file?: File) => {
    if (!file) return;
    void toSmallDataUrl(file).then(setImageUrl);
  };

  const submit = async () => {
    setNameErr(null);
    setCodeErr(null);
    let valid = true;
    if (!name.trim()) {
      setNameErr("اسم اللون مطلوب.");
      valid = false;
    }
    if (!code.trim()) {
      setCodeErr("رقم اللون مطلوب.");
      valid = false;
    }
    if (!valid) return;
    try {
      const normalizedHex = hex?.trim() ? hex.trim() : undefined;
      if (editing) await updateColor(editing.id, { name, code, hex: normalizedHex, imageUrl });
      else await addColor({ fabricId: state.fabricId, name, code, hex: normalizedHex, imageUrl });
      onClose();
    } catch {
      /* error already toasted by the hook */
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-w-md p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden"
      >
        <DialogHeader className="px-6 py-4 border-b border-border shrink-0">
          <DialogTitle>
            {editing ? "تعديل لون" : `إضافة لون جديد — ${fabric?.name ?? ""}`}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-3">
            <div className="flex items-center gap-3">
              <ColorSwatch
                color={{ name, code, hex: hex ?? null, imageUrl: imageUrl ?? null }}
                size="lg"
              />
              <div className="flex-1">
                <Label>صورة اللون (اختياري)</Label>
                <div className="mt-1 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                  >
                    رفع صورة
                  </Button>
                  {imageUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setImageUrl(undefined)}
                    >
                      حذف
                    </Button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </div>
            </div>
            <div>
              <Label>اسم اللون *</Label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameErr(null);
                }}
              />
              {nameErr && <p className="mt-1 text-[11px] text-destructive">{nameErr}</p>}
            </div>
            <div>
              <Label>رقم اللون (Color Code) *</Label>
              <Input
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeErr(null);
                }}
                placeholder="مثال: C-014"
              />
            </div>
            <div className="rounded-md border border-border bg-secondary/30 p-2.5">
              <Label>اللون الحقيقي (Hex) — اختياري</Label>
              <div className="mt-2 flex items-center gap-3">
                <div className="grid h-10 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(hex ?? "") ? hex!.toLowerCase() : "#000000"}
                    onChange={(e) => setHex(e.target.value.toLowerCase())}
                    className="h-full w-full cursor-pointer p-0"
                    aria-label="اختر اللون الحقيقي"
                    title="اختر القيمة البصرية الحقيقية للون"
                  />
                </div>
                <Input
                  value={hex ?? ""}
                  onChange={(e) =>
                    setHex(e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)
                  }
                  placeholder="#000000"
                  className="flex-1 text-[12px] tabular-nums"
                  aria-label="قيمة اللون (Hex)"
                />
                {hex && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setHex(undefined)}>
                    مسح
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-[10.5px] text-muted-foreground">
                تُخزَّن هذه القيمة وتُعرض كما هي في المخزون. <code>code</code> يبقى كود تعريف منفصل.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter className="sticky bottom-0 border-t border-border bg-card px-6 py-4 shrink-0 flex-row-reverse gap-2">
          <Button
            onClick={submit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {editing ? "حفظ" : "إضافة"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ADJUST_REASONS = ["تلف", "عيّنة", "زيادة جرد", "عجز جرد", "تصحيح إدخال", "أخرى"] as const;

/**
 * «تعديل كمية»: add, subtract or set a roll's kg and pieces. Never a silent overwrite —
 * the server records an adjustment movement, the P&L at cost and an audit row (who,
 * when, before, after, why), shown in «تعديلات المخزون», and syncs it to other devices.
 */
export function RollAdjustDialog({ roll, onClose }: { roll: Roll | null; onClose: () => void }) {
  const [mode, setMode] = useState<"delta" | "set">("delta");
  const [kg, setKg] = useState("");
  const [pieces, setPieces] = useState("");
  const [reasonType, setReasonType] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMode("delta");
    setKg("");
    setPieces("");
    setReasonType("");
    setNote("");
  }, [roll?.id]);
  if (!roll) return null;
  const curKg = Number(roll.remainingKg ?? 0);
  const curPieces = Number(roll.remainingPieces ?? 0);
  const kgIn = kg.trim() === "" ? null : Number(kg);
  const piecesIn = pieces.trim() === "" ? null : Number(pieces);
  const newKg = Math.round((mode === "set" ? (kgIn ?? curKg) : curKg + (kgIn ?? 0)) * 100) / 100;
  const newPieces = mode === "set" ? (piecesIn ?? curPieces) : curPieces + (piecesIn ?? 0);
  const deltaKg = Math.round((newKg - curKg) * 100) / 100;
  const deltaPieces = newPieces - curPieces;
  const reason = [reasonType, note.trim()].filter(Boolean).join(": ");
  const valid =
    (kgIn == null || Number.isFinite(kgIn)) &&
    (piecesIn == null || Number.isInteger(piecesIn)) &&
    newKg >= 0 &&
    newPieces >= 0 &&
    (deltaKg !== 0 || deltaPieces !== 0) &&
    reasonType !== "" &&
    (reasonType !== "أخرى" || note.trim().length >= 2);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const tone = (n: number) => (n > 0 ? "text-emerald-600" : n < 0 ? "text-destructive" : "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>تعديل كمية — صبغة #{roll.rollNo}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-1 rounded-lg bg-secondary/50 p-1 text-sm">
            {(
              [
                ["delta", "زيادة / نقص"],
                ["set", "تعيين الكمية"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium ${mode === m ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{mode === "set" ? "الكمية الجديدة (كغ)" : "الكيلوغرام (+ أو −)"}</Label>
              <Input type="number" step="0.01" value={kg} placeholder={mode === "set" ? String(curKg) : "مثال: -2.5"} onChange={(e) => setKg(e.target.value)} />
            </div>
            <div>
              <Label>{mode === "set" ? "عدد الأثواب الجديد" : "الأثواب (+ أو −)"}</Label>
              <Input type="number" step="1" value={pieces} placeholder={mode === "set" ? String(curPieces) : "مثال: 3"} onChange={(e) => setPieces(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2 text-sm tabular-nums">
            <span>
              كغ: {curKg} ← <b>{newKg}</b> <span className={tone(deltaKg)}>({sign(deltaKg)})</span>
            </span>
            <span>
              أثواب: {curPieces} ← <b>{newPieces}</b> <span className={tone(deltaPieces)}>({sign(deltaPieces)})</span>
            </span>
          </div>
          {(newKg < 0 || newPieces < 0) && (
            <p className="text-xs text-destructive">لا يمكن أن تصبح الكمية أو عدد الأثواب سالبة.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>السبب *</Label>
              <select
                className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={reasonType}
                onChange={(e) => setReasonType(e.target.value)}
              >
                <option value="">اختر…</option>
                {ADJUST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>ملاحظة{reasonType === "أخرى" ? " *" : ""}</Label>
              <Input value={note} maxLength={160} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              const ok = await adjustRoll(roll.id, { newKg, newPieces, reason, expectedVersion: roll.version });
              setBusy(false);
              if (ok) onClose();
            }}
          >
            تطبيق التعديل
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RollFormDialog({ state, onClose }: { state: RollFormState; onClose: () => void }) {
  useParties();
  const editing = state.editing;
  const [rollNo, setRollNo] = useState(editing?.rollNo ?? "");
  const [dyeBatch, setDyeBatch] = useState(editing?.dyeBatch ?? "");
  const [qty, setQty] = useState<string>(
    editing?.initialKg != null ? String(editing.initialKg) : "",
  );
  // Pieces are stock like kg (أثواب): entered on create, changed later only by a
  // documented adjustment — never forced to 1.
  const [pieces, setPieces] = useState<string>("1");
  const [remaining, setRemaining] = useState<string>(
    editing?.remainingKg != null ? String(editing.remainingKg) : "",
  );
  const [price, setPrice] = useState<string>(
    editing?.pricePerKg != null ? String(editing.pricePerKg) : "",
  );
  const [currency, setCurrency] = useState<Currency>(editing?.currency ?? "SYP");
  // F12 (Phase 1 audit, "stale supplier picker"): a NEW roll used to default
  // its supplier to `suppliers[0]` — whichever supplier happened to sort
  // first — instead of requiring an explicit choice. A user who didn't
  // notice/change it silently attributed the purchase to the wrong
  // supplier. Only an EDIT should ever pre-fill a supplier (the roll's own
  // recorded one); a new roll starts unset.
  const [supplierId, setSupplierId] = useState<string>(editing?.supplierId ?? "");
  const [date, setDate] = useState<string>(
    editing?.entryDate ?? localToday(),
  );
  const [rollErr, setRollErr] = useState<string | null>(null);
  const [dyeErr, setDyeErr] = useState<string | null>(null);
  const [qtyErr, setQtyErr] = useState<string | null>(null);

  useEffect(() => {
    if (state.open) {
      const e = state.editing;
      setRollNo(e?.rollNo ?? "");
      setDyeBatch(e?.dyeBatch ?? "");
      setQty(e?.initialKg != null ? String(e.initialKg) : "");
      setPieces("1");
      setRemaining(
        e?.remainingKg != null
          ? String(e.remainingKg)
          : e?.initialKg != null
            ? String(e.initialKg)
            : "",
      );
      setPrice(e?.pricePerKg != null ? String(e.pricePerKg) : "");
      setCurrency(e?.currency ?? "SYP");
      setSupplierId(e?.supplierId ?? "");
      setDate(e?.entryDate ?? localToday());
    }
  }, [state.open, state.editing]);

  const [supplierErr, setSupplierErr] = useState<string | null>(null);

  const submit = async () => {
    setRollErr(null);
    setDyeErr(null);
    setQtyErr(null);
    setSupplierErr(null);
    let valid = true;
    if (!rollNo.trim()) {
      setRollErr("رقم الصبغة مطلوب.");
      valid = false;
    }
    if (!dyeBatch.trim()) {
      setDyeErr("رقم الدفعة الصبغية مطلوب.");
      valid = false;
    }
    // F12 (Phase 1 audit, "stale supplier picker"): this field is no longer
    // silently defaulted to `suppliers[0]` — it must be explicitly chosen,
    // same as FabricFormDialog already requires.
    if (!supplierId) {
      setSupplierErr("يرجى اختيار مورد.");
      valid = false;
    }
    const qtyNum = parseDecimalInput(qty);
    const priceNum = parseDecimalInput(price);
    if (qtyNum == null || qtyNum <= 0) {
      setQtyErr("أدخل كمية صحيحة أكبر من صفر.");
      valid = false;
    }
    if (priceNum == null || priceNum <= 0) {
      setQtyErr("أدخل سعر شراء صحيح أكبر من صفر.");
      valid = false;
    }
    const piecesNum = Number(pieces);
    if (!editing && (!Number.isInteger(piecesNum) || piecesNum < 1)) {
      setQtyErr("أدخل عدد أثواب صحيحاً (1 أو أكثر).");
      valid = false;
    }
    if (!valid || qtyNum == null || priceNum == null) return;
    try {
      if (editing) {
        await updateRoll(editing.id, {
          rollNo,
          dyeBatch,
          initialKg: qtyNum,
          // remainingKg is intentionally omitted — stock qty is document-driven.
          pricePerKg: priceNum,
          currency,
          supplierId,
          entryDate: date,
        });
      } else {
        await addRoll({
          colorId: state.colorId,
          rollNo,
          dyeBatch,
          initialKg: qtyNum,
          pieces: piecesNum,
          pricePerKg: priceNum,
          currency,
          supplierId,
          entryDate: date,
        });
      }
      onClose();
    } catch {
      /* error already toasted by the hook */
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-w-xl p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden"
      >
        <DialogHeader className="px-6 py-4 border-b border-border shrink-0">
          <DialogTitle>{editing ? "تعديل صبغة" : "إضافة صبغة جديدة"}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>رقم البكرة *</Label>
              <Input
                value={rollNo}
                onChange={(e) => {
                  setRollNo(e.target.value);
                  setRollErr(null);
                }}
              />
              {rollErr && <p className="mt-1 text-[11px] text-destructive">{rollErr}</p>}
            </div>
            <div>
              <Label>رقم الصبغة *</Label>
              <Input
                value={dyeBatch}
                onChange={(e) => {
                  setDyeBatch(e.target.value);
                  setDyeErr(null);
                }}
              />
              {dyeErr && <p className="mt-1 text-[11px] text-destructive">{dyeErr}</p>}
            </div>
            <div>
              <Label>{editing ? "الكمية المستلمة (كغ)" : "الكمية (كغ) *"}</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                readOnly={!!editing}
                disabled={!!editing}
                title={editing ? "لتصحيح المخزون استخدم «تعديل كمية» من صف الصبغة" : undefined}
                value={qty}
                onChange={(e) => {
                  const v = e.target.value;
                  setQty(v);
                  if (!editing) setRemaining(v);
                  setQtyErr(null);
                }}
              />
              {qtyErr && <p className="mt-1 text-[11px] text-destructive">{qtyErr}</p>}
            </div>
            {!editing && (
              <div>
                <Label>عدد الأثواب *</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  step="1"
                  min="1"
                  value={pieces}
                  onChange={(e) => {
                    setPieces(e.target.value);
                    setQtyErr(null);
                  }}
                />
              </div>
            )}
            {editing && (
              <div>
                <Label>المتبقي (كغ) — للعرض فقط</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={remaining}
                  readOnly
                  disabled
                  title="الكمية المتبقية تُعدَّل عبر الفواتير والمرتجعات فقط"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  تتغيّر الكمية بالفواتير والمرتجعات، أو بزر «تعديل كمية» في صف الصبغة.
                </p>
              </div>
            )}

            <div>
              <Label>سعر الشراء للكغ</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div>
              <Label>العملة</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س (ليرة سورية)</SelectItem>
                  <SelectItem value="USD">$ (دولار)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>المورد *</Label>
              <Select
                value={supplierId}
                onValueChange={(v) => {
                  setSupplierId(v);
                  setSupplierErr(null);
                }}
              >
                <SelectTrigger
                  className={
                    supplierErr ? "border-destructive/60 ring-1 ring-destructive/30" : undefined
                  }
                >
                  <SelectValue placeholder="اختر مورداً" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {supplierErr && <p className="mt-1 text-[11px] text-destructive">{supplierErr}</p>}
            </div>
            <div>
              <Label>تاريخ الدخول</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter className="sticky bottom-0 border-t border-border bg-card px-6 py-4 shrink-0 flex-row-reverse gap-2">
          <Button
            onClick={submit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {editing ? "حفظ" : "إضافة"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { FabricFormDialog, ColorFormDialog, RollFormDialog };
export type { FabricFormState, ColorFormState, RollFormState };

/**
 * A swatch photo, downscaled to ≤480px JPEG. Images ride inside sync units: a raw
 * phone photo (1.2 MB seen in the field) was re-sent on every retry and slowed sync.
 */
async function toSmallDataUrl(file: File, max = 480): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}
