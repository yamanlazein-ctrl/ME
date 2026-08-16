import { ChevronDown, ChevronLeft, CheckCircle2, Layers, PackageX, TrendingDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorSwatch } from "@/components/common/ColorSwatch";
import { colorsOfFabric, fabricById, rollsOfColor, rollStatus, totalKgOfColor, totalPiecesOfColor, totalKgOfFabric, totalPiecesOfFabric, type Color, type Fabric, type Roll } from "@/presentation/hooks/useInventory";
import { supplierById } from "@/presentation/hooks/useParties";
import { RowActions } from "./InventoryHelpers";
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
      className="group flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/60 transition"
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
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
      <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-lg bg-primary/15 text-primary shrink-0">
        {fabric.imageUrl ? (
          <img src={fabric.imageUrl} alt={fabric.name} className="h-full w-full object-cover" />
        ) : (
          <Layers className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground truncate">{fabric.name}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {totalPieces} أثوب • {colorCount} لون • {formatNumber(totalKg)} كغ
          {fabric.category ? ` • ${fabric.category}` : ""}
          {" • "}
          الحد الأدنى {fabric.minStockKg} كغ
        </div>
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
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
      <ColorSwatch color={color} size="md" />

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground truncate">
          {color.name} — <span className="text-muted-foreground tabular-nums">{color.code}</span>
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {pieces} أثوب • {count} صبغة • {formatQuantity(total)} كغ
        </div>
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
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground text-[10px] font-bold tabular-nums">
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
        <div className="grid h-7 w-7 place-items-center rounded-md bg-secondary text-muted-foreground text-[10px] font-bold tabular-nums shrink-0">
          #{roll.rollNo}
        </div>
        <div className="min-w-0 flex-1 grid grid-cols-2 lg:grid-cols-5 gap-2 items-center">
          <div>
            <div className="text-xs text-muted-foreground">المتبقي</div>
            <div className="text-sm font-semibold text-foreground tabular-nums">
              {roll.remainingKg}{" "}
              <span className="text-xs text-muted-foreground">/ {roll.initialKg} كغ</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">الأثواب</div>
            <div className="text-sm font-semibold text-foreground tabular-nums">{roll.pieces ?? 1}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">رقم الصبغة</div>
            <div className="text-sm text-foreground tabular-nums">{roll.dyeBatch}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">المورد</div>
            <div className="text-sm text-foreground truncate">{supplier?.name ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">تاريخ الدخول</div>
            <div className="text-sm text-foreground tabular-nums">{roll.entryDate}</div>
          </div>
        </div>
        <StatusChip r={roll} minKg={minKg} />
        <RowActions onEdit={onEdit} onDelete={onDelete} />
      </div>
    </>
  );
}

export { StatusChip, FabricRow, ColorRow, RollRow };
