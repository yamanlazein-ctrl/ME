import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

function RowActions({
  onEdit,
  onDelete,
  onAdd,
  addLabel,
}: {
  onEdit: () => void;
  onDelete: () => void;
  onAdd?: () => void;
  addLabel?: string;
}) {
  return (
    <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition">
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel}
          title={addLabel}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="grid h-8 w-8 place-items-center rounded-md border border-border bg-background text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:border-primary transition cursor-pointer"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        aria-label="تعديل"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition cursor-pointer"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="حذف"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition cursor-pointer"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function SectionCard({
  index,
  title,
  desc,
  children,
}: {
  index: number;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/60 p-5">
      <header className="mb-4 flex items-center gap-3 border-b border-border pb-3">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-[12px] font-bold text-primary tabular-nums">
          {index}
        </div>
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-foreground">{title}</h4>
          {desc && <p className="text-[11px] text-muted-foreground">{desc}</p>}
        </div>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  error,
  children,
  full,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <Label className="mb-1.5 block text-xs font-semibold text-foreground">
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A compact metric badge: big numeric value with the unit as a small muted
 * suffix, so "12 أثواب" reads as one clear figure instead of a cramped pair.
 */
function StockMetric({
  label,
  value,
  unit,
  primary,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  primary?: boolean;
}) {
  return (
    <div
      className={
        primary
          ? "shrink-0 flex flex-col items-center justify-center rounded-lg bg-primary/10 px-3.5 py-1 text-center"
          : "shrink-0 flex flex-col items-center justify-center rounded-lg bg-secondary/60 px-3.5 py-1 text-center"
      }
      title={`${label}: ${value} ${unit ?? ""}`.trim()}
    >
      <span className="whitespace-nowrap text-[10px] font-medium tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`whitespace-nowrap text-[15px] font-bold leading-tight tabular-nums ${
          primary ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
        {unit ? <span className="mr-1 text-[10px] font-medium text-muted-foreground">{unit}</span> : null}
      </span>
    </div>
  );
}

export { RowActions, SectionCard, Field, StockMetric };
