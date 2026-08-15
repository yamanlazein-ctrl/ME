import { useState, type ReactNode } from "react";
import { ImageIcon, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { addColor, addFabric, type FabricUnit } from "@/presentation/hooks/useInventory";
import { suppliers } from "@/presentation/hooks/useParties";

export type NewFabricPayload = {
  fabricId: string;
  fabricName: string;
  unit: FabricUnit;
  supplierId: string;
  entryDate: string;
  colorId: string;
  colorName: string;
  colorCode: string;
  imageUrl?: string;
  dyeBatch: string;
  widthCm?: number;
  weightGsm?: number;
  quantityKg: number;
  pricePerKg: number;
  salePricePerKg?: number;
};

export function AddFabricModal({
  open,
  onOpenChange,
  onCreated,
  defaultSupplierId,
  defaultDate,
  trigger,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (payload: NewFabricPayload) => void;
  defaultSupplierId?: string;
  defaultDate?: string;
  trigger?: ReactNode;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState<FabricUnit>("kg");

  const [supplierId, setSupplierId] = useState(defaultSupplierId ?? "");
  const [entryDate, setEntryDate] = useState(defaultDate ?? new Date().toISOString().slice(0, 10));
  const [addedBy, setAddedBy] = useState("مسؤول المستودع");

  const [colorName, setColorName] = useState("");
  const [colorCode, setColorCode] = useState("");

  const [dyeBatch, setDyeBatch] = useState("");
  const [widthCm, setWidthCm] = useState<number | "">("");
  const [weightGsm, setWeightGsm] = useState<number | "">("");
  const [quantity, setQuantity] = useState<number | "">("");
  const [purchasePrice, setPurchasePrice] = useState<number | "">("");
  const [salePrice, setSalePrice] = useState<number | "">("");

  const [notes, setNotes] = useState("");
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setCategory("");
    setUnit("kg");
    setSupplierId(defaultSupplierId ?? "");
    setEntryDate(defaultDate ?? new Date().toISOString().slice(0, 10));
    setAddedBy("مسؤول المستودع");
    setColorName("");
    setColorCode("");
    setDyeBatch("");
    setWidthCm("");
    setWeightGsm("");
    setQuantity("");
    setPurchasePrice("");
    setSalePrice("");
    setNotes("");
    setImageUrl(undefined);
    setError(null);
  };

  const handleImage = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageUrl(String(reader.result));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("اسم القماش مطلوب.");
    if (!category.trim()) return setError("التصنيف مطلوب.");
    if (!colorName.trim() || !colorCode.trim()) return setError("اسم اللون ورقم اللون مطلوبان.");
    if (!dyeBatch.trim()) return setError("رقم الصبغة مطلوب.");
    if (!quantity || Number(quantity) <= 0) return setError("الكمية يجب أن تكون أكبر من صفر.");
    if (!purchasePrice || Number(purchasePrice) <= 0) return setError("سعر الشراء مطلوب.");

    try {
      const fab = await addFabric({
        name: name.trim(),
        category: category.trim(),
        minStockKg: 10,
        notes: notes.trim() || undefined,
        unit,
        imageUrl,
      });
      const col = await addColor({
        fabricId: fab.id,
        name: colorName.trim(),
        code: colorCode.trim(),
      });

      onCreated({
        fabricId: fab.id,
        fabricName: fab.name,
        unit,
        supplierId,
        entryDate,
        colorId: col.id,
        colorName: col.name,
        colorCode: col.code,
        imageUrl,
        dyeBatch: dyeBatch.trim(),
        widthCm: widthCm === "" ? undefined : Number(widthCm),
        weightGsm: weightGsm === "" ? undefined : Number(weightGsm),
        quantityKg: Number(quantity),
        pricePerKg: Number(purchasePrice),
        salePricePerKg: salePrice === "" ? undefined : Number(salePrice),
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر حفظ القماش.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setError(null);
      }}
    >
      {trigger}
      <DialogContent
        dir="rtl"
        className="max-w-[960px] max-h-[92vh] overflow-hidden p-0 gap-0 flex flex-col"
      >
        <DialogHeader className="border-b border-border bg-card px-6 py-4 text-right">
          <DialogTitle className="flex items-center gap-2 text-base font-bold text-foreground">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary">
              <Plus className="h-4 w-4" />
            </span>
            إضافة قماش جديد
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            أدخل تفاصيل القماش الجديد. سيتم اختياره تلقائياً في السطر الحالي بعد الحفظ.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <Section number={1} title="المعلومات الأساسية">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="اسم القماش *">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11"
                  placeholder="مثال: قطن مصري"
                />
              </Field>
              <Field label="التصنيف *">
                <Input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-11"
                  placeholder="قطن / شيفون / ساتان..."
                />
              </Field>
              <Field label="الوحدة">
                <Select value={unit} onValueChange={(v) => setUnit(v as FabricUnit)}>
                  <SelectTrigger className="!h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="meter">متر</SelectItem>
                    <SelectItem value="yard">يارد</SelectItem>
                    <SelectItem value="kg">كيلو</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </Section>

          <Section number={2} title="معلومات المورد">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="المورد">
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger className="!h-11">
                    <SelectValue placeholder="اختر المورد" />
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
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  className="h-11"
                />
              </Field>
              <Field label="أضيف بواسطة">
                <Input
                  value={addedBy}
                  onChange={(e) => setAddedBy(e.target.value)}
                  className="h-11"
                />
              </Field>
            </div>
          </Section>

          <Section number={3} title="معلومات اللون">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="اسم اللون *">
                <Input
                  value={colorName}
                  onChange={(e) => setColorName(e.target.value)}
                  className="h-11"
                  placeholder="أزرق سماوي"
                />
              </Field>
              <Field label="رقم اللون *">
                <Input
                  value={colorCode}
                  onChange={(e) => setColorCode(e.target.value)}
                  className="h-11 tabular-nums"
                  placeholder="C-014"
                />
              </Field>
            </div>
          </Section>

          <Section number={4} title="معلومات الرول">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="رقم الصبغة *">
                <Input
                  value={dyeBatch}
                  onChange={(e) => setDyeBatch(e.target.value)}
                  className="h-11 tabular-nums"
                  placeholder="D-0000"
                />
              </Field>
              <Field label="العرض (سم)">
                <Input
                  type="number"
                  step="0.01"
                  value={widthCm}
                  onChange={(e) => setWidthCm(e.target.value === "" ? "" : Number(e.target.value))}
                  className="h-11 tabular-nums"
                />
              </Field>
              <Field label="الوزن / الكثافة (غ/م²)">
                <Input
                  type="number"
                  step="0.01"
                  value={weightGsm}
                  onChange={(e) =>
                    setWeightGsm(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="h-11 tabular-nums"
                />
              </Field>
              <Field label="الكمية *">
                <Input
                  type="number"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value === "" ? "" : Number(e.target.value))}
                  className="h-11 tabular-nums"
                />
              </Field>
              <Field label="سعر الشراء *">
                <Input
                  type="number"
                  step="0.01"
                  value={purchasePrice}
                  onChange={(e) =>
                    setPurchasePrice(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="h-11 tabular-nums"
                />
              </Field>
              <Field label="سعر البيع">
                <Input
                  type="number"
                  step="0.01"
                  value={salePrice}
                  onChange={(e) =>
                    setSalePrice(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className="h-11 tabular-nums"
                />
              </Field>
            </div>
          </Section>

          <Section number={5} title="معلومات إضافية">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="md:col-span-2">
                <Field label="ملاحظات">
                  <Textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="resize-none"
                    placeholder="أي ملاحظات..."
                  />
                </Field>
              </div>
              <Field label="صورة القماش (اختياري)">
                <label className="flex h-[92px] cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border bg-secondary/40 text-xs text-muted-foreground hover:border-primary hover:text-foreground transition overflow-hidden">
                  {imageUrl ? (
                    <img src={imageUrl} alt="قماش" className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <ImageIcon className="h-4 w-4" /> اضغط للرفع
                    </>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleImage(e.target.files?.[0])}
                  />
                </label>
              </Field>
            </div>
          </Section>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-card px-6 py-3 gap-2 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            className="h-10 text-muted-foreground"
          >
            إلغاء
          </Button>
          <Button
            onClick={save}
            className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> حفظ القماش
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-primary/15 text-[11px] font-bold text-primary tabular-nums">
          {number}
        </span>
        <h3 className="text-sm font-bold text-foreground">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
