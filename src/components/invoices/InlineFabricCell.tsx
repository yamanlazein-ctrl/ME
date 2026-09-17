import { useMemo, useRef, useState, forwardRef, type KeyboardEvent } from "react";
import { Check, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { colors, fabrics, fabricById, searchColors, colorByName } from "@/presentation/hooks/useInventory";

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
    if (!q) return [];
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
 * Inline color autocomplete.
 * Search is by typed name across the catalogue (never a dump of every color).
 * A hit on another fabric copies the name; binding the id is the parent's job
 * via resolveColorPick. No match → create on save.
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
    mode?: "both" | "name" | "code";
  }
>(function InlineColorCell(
  { fabricId, name, code, existingColorId, onPickExisting, onSetName, onSetCode, mode = "both" },
  ref,
) {
  const [open, setOpen] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const q = name.trim().toLowerCase();
  const matches = useMemo(() => searchColors(name, 12), [name]);
  const local = colorByName(name, fabricId);
  const isNew = q.length > 0 && !local;

  const nameInput = (
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
        if (e.key === "Enter" && local) {
          e.preventDefault();
          onPickExisting(local.id);
          setOpen(false);
        }
        if (e.key === "Escape") setOpen(false);
      }}
      placeholder="ابحث أو اكتب اسم اللون..."
      className={cn(
        "h-9 min-w-0 w-full border-border bg-background px-2 text-sm focus:border-primary",
        isNew && "text-primary",
      )}
      aria-label="اسم اللون"
    />
  );

  const codeInput = (
    <Input
      ref={mode === "code" ? ref : codeRef}
      value={code}
      onChange={(e) => onSetCode(e.target.value)}
      placeholder="C-000"
      className="h-9 min-w-0 w-full border-border bg-background px-2 text-center text-sm tabular-nums focus:border-primary"
      aria-label="رمز اللون"
    />
  );

  const dropdown =
    open && mode !== "code" && (matches.length > 0 || isNew) ? (
      <div className="absolute right-0 top-full z-20 mt-1 w-full min-w-[240px] rounded-md border border-border bg-popover shadow-lg">
        {matches.map((c) => (
          <button
            key={c.id}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPickExisting(c.id);
              setOpen(false);
            }}
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-right text-sm hover:bg-secondary"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">{c.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {fabricById(c.fabricId)?.name ?? ""}
                {c.code ? ` · ${c.code}` : ""}
              </div>
            </div>
            {c.id === existingColorId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </button>
        ))}
        {isNew && (
          <div className="flex items-center gap-2 border-t border-border bg-primary/5 px-3 py-1.5 text-[11px] font-semibold text-primary">
            <Plus className="h-3.5 w-3.5" />
            إضافة لون «{name.trim()}»
          </div>
        )}
      </div>
    ) : null;

  if (mode === "name") {
    return (
      <div className="relative">
        {nameInput}
        {dropdown}
      </div>
    );
  }
  if (mode === "code") {
    return <div className="relative">{codeInput}</div>;
  }

  return (
    <div className="relative grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-center gap-2">
      {nameInput}
      {codeInput}
      {dropdown}
    </div>
  );
});

// re-export to prevent unused warnings on Sparkles / helpers if we drop them later
export { fabricById, colors };
