import { type KeyboardEvent } from "react";
import { AlertTriangle, Palette, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineFabricCell, InlineColorCell } from "@/components/invoices/InlineFabricCell";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import { rollsOfColor, rollById } from "@/presentation/hooks/useInventory";
import { cn } from "@/lib/utils";
import { formatNumber, formatQuantity, formatMoney } from "@/shared/utils/formatNumber";
import { CardField, GroupSection } from "./InvoiceFormLayout";
import { lineTotal, type SaleLine as SaleLineType } from "./sale-types";

export function SaleLineCard({
  line,
  index,
  isLast,
  isUSD,
  currency,
  fabricRef,
  allLines,
  onUpdate,
  onRemove,
  onPickFabric,
  onPickColor,
  onAppend,
  onAddColor,
}: {
  line: SaleLineType;
  index: number;
  isLast: boolean;
  isUSD: boolean;
  currency: Currency | "";
  fabricRef: (el: HTMLInputElement | null) => void;
  allLines: SaleLineType[];
  onUpdate: (patch: Partial<SaleLineType>) => void;
  onRemove: () => void;
  onPickFabric: (fabricId: string) => void;
  onPickColor: (colorId: string) => void;
  onAppend: () => void;
  onAddColor?: () => void;
}) {
  const rowIsEmpty = line.fabricName.trim() === "" && line.rollId === "" && line.quantityKg === 0;

  const availableRolls = line.colorId
    ? rollsOfColor(line.colorId).filter((r) => r.remainingKg > 0 || r.id === line.rollId)
    : [];
  const roll = rollById(line.rollId);
  const exceeds = roll ? line.quantityKg > roll.remainingKg : false;

  return (
    <article
      className={cn(
        "group rounded-lg border bg-background/60 transition",
        rowIsEmpty
          ? "border-dashed border-primary/30 bg-primary/[0.02]"
          : "border-border hover:border-primary/40 hover:shadow-sm",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "grid h-6 min-w-[28px] place-items-center rounded-md px-2 text-[11px] font-bold tabular-nums",
              rowIsEmpty ? "bg-primary/10 text-primary" : "bg-primary text-primary-foreground",
            )}
          >
            {index + 1}
          </span>
          <span className="text-xs font-semibold text-foreground">
            البند رقم {index + 1}
            {!rowIsEmpty && line.fabricName && (
              <span className="mr-1.5 font-normal text-muted-foreground">
                — {line.fabricName}
                {line.colorName && ` / ${line.colorName}`}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!rowIsEmpty && (
            <span className={cn("text-xs font-bold tabular-nums", isUSD ? "text-success" : "text-foreground")}>
              {formatMoney(lineTotal(line))}{" "}
              <span className="text-[10px] font-medium text-muted-foreground">{currencySymbol(currency)}</span>
            </span>
          )}
          {!rowIsEmpty && line.fabricId && onAddColor && (
            <button
              type="button"
              onClick={onAddColor}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
              aria-label="إضافة لون لنفس القماش"
              title={`إضافة لون جديد لـ ${line.fabricName}`}
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          )}
          {!rowIsEmpty && (
            <button
              type="button"
              onClick={onRemove}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
              aria-label="حذف البند"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2 p-3">
        <GroupSection title="بيانات القماش">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <CardField label="نوع القماش" required>
              <InlineFabricCell
                ref={fabricRef}
                value={line.fabricName}
                existingFabricId={line.fabricId || undefined}
                onPickExisting={onPickFabric}
                onSetName={(name) =>
                  onUpdate({ fabricName: name, fabricId: "", colorId: "", colorName: "", colorCode: "", rollId: "" })
                }
              />
            </CardField>
            <CardField label="اللون / رقم اللون" required>
              <InlineColorCell
                fabricId={line.fabricId || undefined}
                name={line.colorName}
                code={line.colorCode}
                existingColorId={line.colorId || undefined}
                onPickExisting={onPickColor}
                onSetName={(name) => onUpdate({ colorName: name, colorId: "", rollId: "" })}
                onSetCode={(code) => onUpdate({ colorCode: code, colorId: "", rollId: "" })}
              />
            </CardField>
          </div>
        </GroupSection>

        <GroupSection title="بيانات الصبغة">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <CardField label="رقم الصبغة" required>
              <Select value={line.rollId} onValueChange={(v) => onUpdate({ rollId: v })} disabled={!line.colorId}>
                <SelectTrigger className="!h-9">
                  <SelectValue placeholder={line.colorId ? "اختر صبغة" : "اختر القماش واللون أولاً"} />
                </SelectTrigger>
                <SelectContent>
                  {availableRolls.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">لا توجد صبغات متاحة لهذا اللون.</div>
                  )}
                  {availableRolls.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      #{r.rollNo} — متاح {r.remainingKg} كغ
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardField>
            <CardField label="المتاح (كغ)">
              <div
                className={cn(
                  "flex h-9 items-center rounded-md border border-border bg-secondary/30 px-3 text-sm tabular-nums",
                  roll ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {roll ? `${formatQuantity(roll.remainingKg)} كغ` : "—"}
              </div>
            </CardField>
          </div>
        </GroupSection>

        <GroupSection title="بيانات البيع">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <CardField label="الكمية (كغ)" required>
              <Input
                type="number"
                step="0.01"
                value={line.quantityKg || ""}
                onChange={(e) => onUpdate({ quantityKg: e.target.value === "" ? 0 : Number(e.target.value) })}
                className={cn(
                  "h-9 text-left tabular-nums",
                  exceeds && "border-destructive text-destructive focus-visible:ring-destructive/30",
                )}
                placeholder="0"
                aria-label="الكمية"
              />
            </CardField>
            <CardField label="الأثواب">
              <Input
                type="number"
                min="1"
                value={line.pieces || ""}
                onChange={(e) => onUpdate({ pieces: e.target.value === "" ? 1 : Math.max(1, Number(e.target.value)) })}
                className="h-9 text-left tabular-nums"
                placeholder="1"
                aria-label="عدد الأثواب"
              />
            </CardField>
            <CardField label={`السعر / كغ${currency ? ` (${currencySymbol(currency)})` : " (اختر العملة)"}`} required>
              <Input
                type="number"
                step="0.01"
                value={line.pricePerKg || ""}
                onChange={(e) => onUpdate({ pricePerKg: e.target.value === "" ? 0 : Number(e.target.value) })}
                className={cn("h-9 text-left tabular-nums", isUSD && "text-success font-semibold")}
                placeholder="0"
                aria-label="سعر الوحدة"
              />
            </CardField>
            <CardField label="الخصم">
              <Input
                type="number"
                step="0.01"
                value={line.discountAmount || ""}
                onChange={(e) => onUpdate({ discountAmount: e.target.value === "" ? 0 : Number(e.target.value) })}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (isLast) {
                      onAppend();
                    } else {
                      const next = allLines[index + 1];
                      if (next) {
                        // Focus next fabric input — handled by caller via ref
                      }
                    }
                  }
                }}
                className="h-9 text-left tabular-nums"
                placeholder="0"
                aria-label="الخصم"
              />
            </CardField>
            <div className="flex items-end justify-end">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">الإجمالي</span>
                <span className={cn("text-lg font-black tabular-nums leading-tight", isUSD ? "text-success" : "text-foreground")}>
                  {formatMoney(lineTotal(line))}{" "}
                  <span className="text-[10px] font-medium text-muted-foreground">{currencySymbol(currency)}</span>
                </span>
              </div>
            </div>
          </div>
          {exceeds && roll && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              الكمية تتجاوز المتاح في الصبغة ({roll.remainingKg} كغ).
            </div>
          )}
        </GroupSection>

        <GroupSection title="ملاحظة (اختياري)">
          <Input
            value={line.note ?? ""}
            onChange={(e) => onUpdate({ note: e.target.value })}
            className="h-9"
            placeholder="—"
            aria-label="ملاحظة السطر"
          />
        </GroupSection>
      </div>
    </article>
  );
}
