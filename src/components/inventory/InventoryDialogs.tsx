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
    setPurchasePrice("");
    setSalePrice("");
    setCurrency("SYP");
    setNotes(e?.notes ?? "");
    setImageUrl(e?.imageUrl ?? "");
    setError(null);
  }, [state.open, state.editing]);

  const onImagePick = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result));
    reader.readAsDataURL(file);
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
            pieces: 1,
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
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result));
    reader.readAsDataURL(file);
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

function RollFormDialog({ state, onClose }: { state: RollFormState; onClose: () => void }) {
  useParties();
  const editing = state.editing;
  const [rollNo, setRollNo] = useState(editing?.rollNo ?? "");
  const [dyeBatch, setDyeBatch] = useState(editing?.dyeBatch ?? "");
  const [qty, setQty] = useState<string>(
    editing?.initialKg != null ? String(editing.initialKg) : "",
  );
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
          pieces: 1,
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
              <Label>الكمية (كغ) *</Label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
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
                  لا يمكن تعديل المخزون من هنا — استخدم فاتورة دخول/بيع أو مرتجع.
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
