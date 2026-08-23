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
  const piecesExceeds = roll
    ? (line.pieces || 1) > (roll.remainingPieces ?? roll.pieces ?? 1)
    : false;

  return (
    <article
      className={cn(
        "group rounded-lg border bg-background/60 transition",
        rowIsEmpty
          ? "border-dashed border-border/60 bg-secondary/[0.02]"
          : "border-border hover:border-primary/30",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "grid h-6 min-w-[28px] place-items-center rounded-md px-2 text-[11px] font-medium tabular-nums",
              rowIsEmpty ? "bg-secondary/60 text-muted-foreground" : "bg-secondary text-foreground",
            )}
          >
            {index + 1}
          </span>
          <span className="text-xs font-medium text-muted-foreground">
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
            <span
              className={cn(
                "text-xs font-bold tabular-nums",
                isUSD ? "text-success" : "text-foreground",
              )}
            >
              {formatMoney(lineTotal(line))}
              <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
                {currencySymbol(currency)}
              </span>
            </span>
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

      <div className="space-y-3 p-4">
        <GroupSection title="بيانات القماش">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <CardField label="نوع القماش" required>
              <InlineFabricCell
                ref={fabricRef}
                value={line.fabricName}
                existingFabricId={line.fabricId || undefined}
                onPickExisting={onPickFabric}
                onSetName={(name) =>
                  onUpdate({
                    fabricName: name,
                    fabricId: "",
                    colorId: "",
                    colorName: "",
                    colorCode: "",
                    rollId: "",
                  })
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
          {line.fabricId && onAddColor && (
            <button
              type="button"
              onClick={onAddColor}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary transition hover:bg-primary/20"
              aria-label="إضافة لون آخر لنفس القماش"
            >
              <Palette className="h-3.5 w-3.5" />
              + إضافة لون آخر لنفس القماش
            </button>
          )}
        </GroupSection>

        <GroupSection title="بيانات الصبغة">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <CardField label="رقم الصبغة" required>
              <Select
                value={line.rollId}
                onValueChange={(v) => onUpdate({ rollId: v })}
                disabled={!line.colorId}
              >
                <SelectTrigger className="!h-9">
                  <SelectValue
                    placeholder={line.colorId ? "اختر صبغة" : "اختر القماش واللون أولاً"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableRolls.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      لا توجد صبغات متاحة لهذا اللون.
                    </div>
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1fr)]">
            <CardField label="الكمية (كغ)" required>
              <Input
                type="number"
                step="0.01"
                value={line.quantityKg || ""}
                onChange={(e) =>
                  onUpdate({ quantityKg: e.target.value === "" ? 0 : Number(e.target.value) })
                }
                className={cn(
                  "h-9 text-left tabular-nums",
                  !line.quantityKg && "text-muted-foreground/70",
                  exceeds &&
                    "border-destructive text-destructive focus-visible:ring-destructive/30",
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
                onChange={(e) =>
                  onUpdate({
                    pieces: e.target.value === "" ? 1 : Math.max(1, Number(e.target.value)),
                  })
                }
                className={cn("h-9 text-left tabular-nums", !line.pieces && "text-muted-foreground/70")}
                placeholder="1"
                aria-label="عدد الأثواب"
              />
            </CardField>
            <CardField
              label={`السعر / كغ${currency ? ` (${currencySymbol(currency)})` : " (اختر العملة)"}`}
              required
            >
              <Input
                type="number"
                step="0.01"
                value={line.pricePerKg || ""}
                onChange={(e) =>
                  onUpdate({ pricePerKg: e.target.value === "" ? 0 : Number(e.target.value) })
                }
                className={cn("h-9 text-left tabular-nums", !line.pricePerKg && "text-muted-foreground/70", isUSD && line.pricePerKg > 0 && "text-success font-semibold")}
                placeholder="0"
                aria-label="سعر الوحدة"
              />
            </CardField>
            <CardField label="الخصم">
              <Input
                type="number"
                step="0.01"
                value={line.discountAmount || ""}
                onChange={(e) =>
                  onUpdate({ discountAmount: e.target.value === "" ? 0 : Number(e.target.value) })
                }
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
                className={cn("h-9 text-left tabular-nums", !line.discountAmount && "text-muted-foreground/70")}
                placeholder="0"
                aria-label="الخصم"
              />
            </CardField>
            <div className="flex items-end justify-end">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  الإجمالي
                </span>
                <span
                  className={cn(
                    "text-lg font-black tabular-nums leading-tight",
                    isUSD ? "text-success" : "text-foreground",
                  )}
                >
                  {formatMoney(lineTotal(line))}
                  <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
                    {currencySymbol(currency)}
                  </span>
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
          {piecesExceeds && roll && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              الأثواب تتجاوز المتاح في الصبغة ({roll.remainingPieces ?? roll.pieces ?? 1} أثواب).
            </div>
          )}
        </GroupSection>

        <GroupSection title="ملاحظة (اختياري)">
          <Input
            value={line.note ?? ""}
            onChange={(e) => onUpdate({ note: e.target.value })}
            className={cn("h-9", !line.note && "text-muted-foreground/70")}
            placeholder="—"
            aria-label="ملاحظة السطر"
          />
        </GroupSection>
      </div>
    </article>
  );
}
