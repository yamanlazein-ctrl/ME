import {
  ChevronLeft,
  CheckCircle2,
  Layers,
  PackageX,
  TrendingDown,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorSwatch } from "@/components/common/ColorSwatch";
import {
  colorsOfFabric,
  fabricById,
  rollsOfColor,
  rollStatus,
  totalKgOfColor,
  totalPiecesOfColor,
  totalKgOfFabric,
  totalPiecesOfFabric,
  type Color,
  type Fabric,
  type Roll,
} from "@/presentation/hooks/useInventory";
import { supplierById } from "@/presentation/hooks/useParties";
import { RowActions, StockMetric } from "./InventoryHelpers";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

function StatusChip({ r, minKg }: { r: Roll; minKg: number }) {
  const s = rollStatus(r, minKg);
  if (s === "out")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive">
        <PackageX className="h-3 w-3" /> منتهية
      </span>
    );
  if (s === "low")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-warning/20 px-2 py-0.5 text-[11px] font-semibold text-warning">
        <TrendingDown className="h-3 w-3" /> منخفضة
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
      <CheckCircle2 className="h-3 w-3" /> نشطة
    </span>
  );
}

/** Shared column template for desktop roll rows + their header (keeps both aligned). */
const ROLL_COLS =
  "grid grid-cols-[minmax(4.5rem,auto)_minmax(7rem,1.1fr)_4.5rem_minmax(6rem,0.9fr)_minmax(7rem,1.4fr)_minmax(6.5rem,0.9fr)_6.5rem_auto] items-center gap-x-3";

/** One column-header row rendered above the rolls of an expanded color. */
function RollsHeader() {
  return (
    <div
      className={`hidden md:grid ${ROLL_COLS} border-b border-border bg-background/80 px-4 pr-20 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground`}
      dir="rtl"
    >
      <span>الصبغة</span>
      <span>المتبقي / الأصلي</span>
      <span>الأثواب</span>
      <span>رقم الصبغة</span>
      <span>المورد</span>
      <span>تاريخ الدخول</span>
      <span>الحالة</span>
      <span />
    </div>
  );
}

function FabricRow({
  fabric,
  open,
  onToggle,
  onEdit,
  onDelete,
  onAddColor,
  selectable,
  selected,
  onSelect,
}: {
  fabric: Fabric;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddColor: () => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const totalKg = totalKgOfFabric(fabric.id);
  const totalPieces = totalPiecesOfFabric(fabric.id);
  const colorCount = colorsOfFabric(fabric.id).length;
  return (
    <div
      className="group flex items-center gap-3 border-b border-border bg-secondary/40 px-4 py-3 cursor-pointer hover:bg-secondary/70 transition"
      onClick={onToggle}
    >
      {selectable && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => onSelect?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`تحديد ${fabric.name}`}
        />
      )}
      <button
        type="button"
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground"
        aria-label={open ? "طي" : "فتح"}
      >
        <ChevronLeft
          className={`h-4 w-4 transition-transform duration-200 ${open ? "-rotate-90" : ""}`}
        />
      </button>
      <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-lg bg-primary/15 text-primary shrink-0">
        {fabric.imageUrl ? (
          <img src={fabric.imageUrl} alt={fabric.name} className="h-full w-full object-cover" />
        ) : (
          <Layers className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-foreground truncate">{fabric.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {colorCount} لون
          </span>
          {fabric.category && (
            <span className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {fabric.category}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            حد أدنى {fabric.minStockKg} كغ
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StockMetric label="أثواب متبقية" value={totalPieces} primary />
        <StockMetric label="الوزن المتبقي" value={formatNumber(totalKg)} unit="كغ" />
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} onAdd={onAddColor} addLabel="إضافة لون" />
    </div>
  );
}

function ColorRow({
  color,
  open,
  onToggle,
  onEdit,
  onDelete,
  onAddRoll,
  selectable,
  selected,
  onSelect,
}: {
  color: Color;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddRoll: () => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const total = totalKgOfColor(color.id);
  const pieces = totalPiecesOfColor(color.id);
  const count = rollsOfColor(color.id).length;
  return (
    <div
      className="group flex items-center gap-3 px-4 py-2.5 pr-10 cursor-pointer hover:bg-secondary/80 transition border-t border-border"
      onClick={onToggle}
    >
      {selectable && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => onSelect?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`تحديد ${color.name}`}
        />
      )}
      <button
        type="button"
        className="grid h-6 w-6 place-items-center rounded text-muted-foreground"
      >
        <ChevronLeft
          className={`h-4 w-4 transition-transform duration-200 ${open ? "-rotate-90" : ""}`}
        />
      </button>
      <ColorSwatch color={color} size="md" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold text-foreground truncate">{color.name}</span>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground tabular-nums">
            كود {color.code}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums">{count} صبغة</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StockMetric label="أثواب متبقية" value={pieces} primary />
        <StockMetric label="الوزن المتبقي" value={formatQuantity(total)} unit="كغ" />
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} onAdd={onAddRoll} addLabel="إضافة صبغة" />
    </div>
  );
}

function RollRow({
  roll,
  minKg,
  onEdit,
  onDelete,
  selectable,
  selected,
  onSelect,
}: {
  roll: Roll;
  minKg: number;
  onEdit: () => void;
  onDelete: () => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const status = rollStatus(roll, minKg);
  const supplier = supplierById(roll.supplierId);
  return (
    <>
      {/* Mobile: stacked card (< md) */}
      <div
        className={`group md:hidden flex flex-col gap-1.5 px-3 py-3 border-b border-border/40 hover:bg-secondary/40 transition ${
          status === "out" ? "opacity-60" : ""
        }`}
      >
        {/* Header row: roll number + status (+ select checkbox) */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {selectable && (
              <Checkbox
                checked={!!selected}
                onCheckedChange={() => onSelect?.()}
                aria-label={`تحديد الصبغة #${roll.rollNo}`}
              />
            )}
            <span className="grid h-7 min-w-[2.5rem] shrink-0 place-items-center rounded-md bg-secondary px-1.5 text-muted-foreground text-[10px] font-bold tabular-nums">
              #{roll.rollNo}
            </span>
            <span className="text-sm font-semibold text-foreground truncate">
              رقم الصبغة {roll.rollNo}
            </span>
          </div>
          <StatusChip r={roll} minKg={minKg} />
        </div>

        {/* Fields: label: value, one per line */}
        <dl className="mt-1 space-y-1 text-[13px]">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">الكمية المتبقية</dt>
            <dd className="font-semibold text-foreground tabular-nums">
              {roll.remainingKg} / {roll.initialKg} كغ
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">عدد الأثواب</dt>
            <dd className="font-semibold text-foreground tabular-nums">{roll.pieces ?? 1} أثوب</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">رقم الصبغة</dt>
            <dd className="text-foreground tabular-nums truncate">{roll.dyeBatch}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">المورد</dt>
            <dd className="text-foreground truncate text-left">{supplier?.name ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">تاريخ الدخول</dt>
            <dd className="text-foreground tabular-nums">{roll.entryDate}</dd>
          </div>
        </dl>

        {/* Actions row: consistent bottom position */}
        <div className="mt-2 flex justify-end">
          <RowActions onEdit={onEdit} onDelete={onDelete} />
        </div>
      </div>

      {/* Desktop: original inline row (md+) */}
      <div
        className={`group hidden md:flex items-center gap-3 px-4 py-2.5 pr-20 hover:bg-secondary/40 transition ${
          status === "out" ? "opacity-60" : ""
        }`}
      >
        {selectable && (
          <Checkbox
            checked={!!selected}
            onCheckedChange={() => onSelect?.()}
            aria-label={`تحديد الصبغة #${roll.rollNo}`}
          />
        )}
        <div className={`${ROLL_COLS} min-w-0 flex-1`} dir="rtl">
          <span className="inline-flex h-7 min-w-[2.5rem] items-center justify-center rounded-md bg-primary/10 px-1.5 text-[11px] font-bold text-primary tabular-nums">
            #{roll.rollNo}
          </span>
          <div className="min-w-0">
            <div className="whitespace-nowrap text-sm font-bold text-foreground tabular-nums">
              {roll.remainingKg}
              <span className="text-[10px] font-medium text-muted-foreground"> / {roll.initialKg} كغ</span>
            </div>
            <div className="mt-0.5 h-1 w-full max-w-[7rem] overflow-hidden rounded-full bg-secondary">
              <div
                className={`h-full rounded-full ${
                  status === "out" ? "bg-destructive/50" : status === "low" ? "bg-warning" : "bg-success"
                }`}
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, roll.initialKg > 0 ? (roll.remainingKg / roll.initialKg) * 100 : 0),
                  )}%`,
                }}
              />
            </div>
          </div>
          <div className="whitespace-nowrap text-sm font-bold text-primary tabular-nums">
            {roll.pieces ?? 1}
          </div>
          <div className="truncate text-sm text-foreground tabular-nums">{roll.dyeBatch}</div>
          <div className="truncate text-sm text-foreground">{supplier?.name ?? "—"}</div>
          <div className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">{roll.entryDate}</div>
          <StatusChip r={roll} minKg={minKg} />
          <RowActions onEdit={onEdit} onDelete={onDelete} />
        </div>
      </div>
    </>
  );
}

export { StatusChip, FabricRow, ColorRow, RollRow, RollsHeader };
