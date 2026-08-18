import { useMemo, useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Plus, Check } from "lucide-react";

/**
 * Free-text combobox: type any value. Existing values autocomplete.
 * New values become available next time via `onAdd`.
 */
export function NameCombobox({
  value,
  onChange,
  options,
  onAdd,
  placeholder,
  className,
  allowCreate = true,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  onAdd?: (v: string) => void;
  placeholder?: string;
  className?: string;
  allowCreate?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const q = value.trim();
  const matches = useMemo(() => {
    if (!q) return options.slice(0, 20);
    return options.filter((o) => o.toLowerCase().includes(q.toLowerCase())).slice(0, 20);
  }, [q, options]);
  const exact = q && options.some((o) => o === q);
  const canCreate = allowCreate && !!q && !exact;

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const pick = (v: string) => {
    onChange(v);
    if (!options.includes(v)) onAdd?.(v);
    setOpen(false);
  };

  const totalItems = matches.length + (canCreate ? 1 : 0);

  return (
    <div ref={wrap} className={cn("relative", className)}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setFocus(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setFocus((f) => Math.min(f + 1, totalItems - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocus((f) => Math.max(f - 1, 0));
          } else if (e.key === "Enter") {
            if (!open) return;
            e.preventDefault();
            if (focus < matches.length) pick(matches[focus]);
            else if (canCreate) pick(q);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="h-10"
        autoComplete="off"
      />
      {open && (matches.length > 0 || canCreate) && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover shadow-lg">
          {matches.map((m, i) => (
            <button
              type="button"
              key={m}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(m)}
              className={cn(
                "flex w-full items-center justify-between px-3 py-2 text-right text-sm hover:bg-secondary",
                i === focus && "bg-secondary",
              )}
            >
              <span>{m}</span>
              {value === m && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(q)}
              className={cn(
                "flex w-full items-center gap-2 border-t border-border px-3 py-2 text-right text-sm text-primary hover:bg-primary/10",
                focus === matches.length && "bg-primary/10",
              )}
            >
              <Plus className="h-4 w-4" />
              <span>إضافة "{q}" كاسم مصروف جديد</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
