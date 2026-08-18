import { useMemo, useRef, useState, forwardRef, type KeyboardEvent } from "react";
import { Check, Plus, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { colors, colorsOfFabric, fabrics, fabricById } from "@/presentation/hooks/useInventory";

/**
 * Inline fabric autocomplete for a table cell.
 * - Free-text input, filters existing fabrics as the user types.
 * - Selecting a match calls onPickExisting(fabricId).
 * - Typing a name and pressing Enter/Tab that doesn't match commits the typed
 *   name via onSetName — the parent will register a NEW fabric on save.
 */
export const InlineFabricCell = forwardRef<
  HTMLInputElement,
  {
    value: string; // current fabric name
    existingFabricId?: string;
    onPickExisting: (fabricId: string) => void;
    onSetName: (name: string) => void;
    onEnter?: () => void;
    className?: string;
  }
>(function InlineFabricCell(
  { value, existingFabricId, onPickExisting, onSetName, onEnter, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  const q = value.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!q) return fabrics.slice(0, 8);
    return fabrics.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
  }, [q]);

  const exactMatch = fabrics.find((f) => f.name.toLowerCase() === q);
  const isNew = q.length > 0 && !exactMatch;

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (matches.length === 1 && !existingFabricId) {
        e.preventDefault();
        onPickExisting(matches[0].id);
        setOpen(false);
      } else if (onEnter) {
        // fall through — parent handles row advancement
      }
    }
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        ref={ref}
        value={value}
        onChange={(e) => {
          onSetName(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKey}
        placeholder="اكتب اسم القماش..."
        className={cn(
          "h-8 w-full border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-primary focus:bg-background",
          isNew && "text-primary",
          className,
        )}
        aria-label="القماش"
      />
      {isNew && (
        <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-primary">
          جديد
        </span>
      )}
      {open && (matches.length > 0 || isNew) && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[260px] rounded-md border border-border bg-popover shadow-lg">
          {matches.map((f) => (
            <button
              key={f.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPickExisting(f.id);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-1.5 text-right text-sm hover:bg-secondary"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{f.name}</div>
                {f.category && (
                  <div className="truncate text-[10px] text-muted-foreground">{f.category}</div>
                )}
              </div>
              {f.id === existingFabricId && <Check className="h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
          {isNew && (
            <div className="flex items-center gap-2 border-t border-border bg-primary/5 px-3 py-1.5 text-[11px] font-semibold text-primary">
              <Plus className="h-3.5 w-3.5" />
              سيُسجَّل "{value}" كقماش جديد
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Inline color autocomplete for a table cell.
 * - When a fabric is picked (existingFabricId set): shows registered colors of
 *   that fabric AND allows adding a new one by typing a fresh name.
 * - When the fabric is new (no existingFabricId): pure free-text; parent will
 *   register the color on save.
 */
export const InlineColorCell = forwardRef<
  HTMLInputElement,
  {
    fabricId?: string;
    name: string;
    code: string;
    existingColorId?: string;
    onPickExisting: (colorId: string) => void;
    onSetName: (name: string) => void;
    onSetCode: (code: string) => void;
  }
>(function InlineColorCell(
  { fabricId, name, code, existingColorId, onPickExisting, onSetName, onSetCode },
  ref,
) {
  const [open, setOpen] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => (fabricId ? colorsOfFabric(fabricId) : []), [fabricId]);
  const q = name.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? options.filter((c) => c.name.toLowerCase().includes(q)) : options),
    [options, q],
  );
  const exact = options.find((c) => c.name.toLowerCase() === q);
  const isNew = q.length > 0 && !exact && !!fabricId;

  return (
    <div className="relative flex items-center gap-1">
      <Input
        ref={ref}
        value={name}
        onChange={(e) => {
          onSetName(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length === 1) {
            e.preventDefault();
            onPickExisting(matches[0].id);
            setOpen(false);
          }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="اللون"
        className={cn(
          "h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-primary focus:bg-background",
          isNew && "text-primary",
        )}
        aria-label="اسم اللون"
      />
      <Input
        ref={codeRef}
        value={code}
        onChange={(e) => onSetCode(e.target.value)}
        placeholder="C-000"
        className="h-8 w-16 border-transparent bg-transparent px-1 text-center text-[11px] tabular-nums hover:border-border focus:border-primary focus:bg-background"
        aria-label="رمز اللون"
      />
      {open && matches.length > 0 && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[220px] rounded-md border border-border bg-popover shadow-lg">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onPickExisting(c.id);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-1.5 text-right text-sm hover:bg-secondary"
            >
              <span className="truncate font-medium text-foreground">{c.name}</span>
              <span className="tabular-nums text-[10px] text-muted-foreground">{c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// re-export to prevent unused warnings on Sparkles / helpers if we drop them later
export { fabricById, colors };
