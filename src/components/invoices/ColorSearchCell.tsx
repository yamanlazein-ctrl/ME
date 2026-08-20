import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ImagePlus, Sparkles, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { colorByCode, searchColors, type Color } from "@/presentation/hooks/useInventory";
import { ColorSwatch } from "@/components/common/ColorSwatch";

/**
 * Search-first colour picker linked to inventory.
 *
 * As the operator types in "رقم اللون" (or the name field), we search all
 * registered colours by code OR name — the same "search existing first"
 * pattern used for fabrics on this screen. An exact code/name match
 * auto-selects that colour and fills the other field. If no match is
 * found the input is clearly flagged as "لون جديد" and the operator can
 * proceed to create it as part of this invoice, with an optional swatch
 * image.
 */
export function ColorSearchCell({
  name,
  code,
  hex,
  existingColorId,
  imageUrl,
  fabricId,
  onPickExisting,
  onSetName,
  onSetCode,
  onSetHex,
  onSetImage,
}: {
  name: string;
  code: string;
  hex?: string;
  existingColorId?: string;
  imageUrl?: string;
  /**
   * Fix C-11 (forensic audit 2026-08-15): the code-match preview below
   * must be scoped to the fabric this line actually resolves to. While
   * the fabric hasn't been resolved yet (still-unmatched free text), this
   * is undefined and colorByCode() correctly returns "no match" rather
   * than searching every fabric in the tenant — the same cross-fabric
   * merge this fix closes at save time in invoices.entry.new.tsx.
   */
  fabricId?: string;
  onPickExisting: (color: Color) => void;
  onSetName: (name: string) => void;
  onSetCode: (code: string) => void;
  onSetHex?: (hex: string | undefined) => void;
  onSetImage?: (dataUrl: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<"code" | "name">("code");
  const fileRef = useRef<HTMLInputElement>(null);

  const query = activeField === "code" ? code : name;
  const matches = useMemo(() => searchColors(query, 8), [query]);
  const codeMatch = useMemo(() => colorByCode(code, fabricId), [code, fabricId]);
  const nameMatch = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    return matches.find((c) => c.name.toLowerCase() === q);
  }, [name, matches]);
  const matched = existingColorId ? true : Boolean(codeMatch ?? nameMatch);
  const isNew = !matched && (code.trim().length > 0 || name.trim().length > 0);

  const pick = (c: Color) => {
    onPickExisting(c);
    setOpen(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setOpen(false);
    if (e.key === "Enter" && matches.length === 1 && !existingColorId) {
      e.preventDefault();
      pick(matches[0]);
    }
  };

  const handleFile = (file?: File) => {
    if (!file || !onSetImage) return;
    const reader = new FileReader();
    reader.onload = () => onSetImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  // Show the matched color's swatch even before the parent commits its ID
  const previewColor = existingColorId ? (codeMatch ?? nameMatch) : (codeMatch ?? nameMatch);
  const displaySwatch =
    previewColor ??
    (isNew && (imageUrl || hex)
      ? ({ code, name, hex: hex ?? null, imageUrl: imageUrl ?? null } as {
          code: string;
          name: string;
          hex: string | null;
          imageUrl: string | null;
        })
      : null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2">
        {/* Swatch preview / upload for new colours */}
        <div className="relative">
          {displaySwatch ? (
            <ColorSwatch color={displaySwatch} size="lg" />
          ) : (
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border-2 border-dashed border-border bg-muted/30 text-muted-foreground">
              <Sparkles className="h-4 w-4" />
            </div>
          )}
          {onSetImage && (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="absolute -bottom-1 -left-1 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-primary"
                aria-label="صورة اللون"
                title="رفع صورة اللون"
              >
                <ImagePlus className="h-3 w-3" />
              </button>
              {imageUrl && (
                <button
                  type="button"
                  onClick={() => onSetImage(undefined)}
                  className="absolute -top-1 -left-1 grid h-4 w-4 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-destructive"
                  aria-label="حذف الصورة"
                  title="حذف الصورة"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </>
          )}
        </div>

        {/* Colour code — the search anchor */}
        <div className="relative">
          <Input
            value={code}
            onChange={(e) => {
              const v = e.target.value;
              onSetCode(v);
              setActiveField("code");
              setOpen(true);
            }}
            onFocus={() => {
              setActiveField("code");
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 140)}
            onKeyDown={handleKey}
            placeholder="C-000"
            className={cn(
              "h-9 text-center tabular-nums",
              matched && "border-primary/40 bg-primary/[0.03]",
              isNew && "border-warning/40 text-primary",
            )}
            aria-label="رقم اللون"
          />
        </div>

        {/* Colour name — auto-filled on match, editable for new */}
        <div className="relative">
          <Input
            value={name}
            onChange={(e) => {
              onSetName(e.target.value);
              setActiveField("name");
              setOpen(true);
            }}
            onFocus={() => {
              setActiveField("name");
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 140)}
            onKeyDown={handleKey}
            placeholder="اسم اللون"
            className={cn("h-9", matched && "border-primary/40 bg-primary/[0.03]")}
            aria-label="اسم اللون"
          />
        </div>
      </div>

      {/* Status line */}
      <div className="flex items-center gap-2 text-[10.5px]">
        {matched ? (
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
            <Check className="h-3 w-3" /> لون مسجّل
          </span>
        ) : isNew ? (
          <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-semibold text-muted-foreground">
            <Sparkles className="h-3 w-3" /> لون جديد — سيُسجَّل عند الحفظ
          </span>
        ) : (
          <span className="text-muted-foreground">اكتب الرقم أو الاسم للبحث في المخزون</span>
        )}
        {onSetImage && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-primary"
            aria-label="إضافة صورة اللون"
            title="إضافة صورة اللون"
          >
            <ImagePlus className="h-3 w-3" />
            {imageUrl ? "تغيير الصورة" : "أضف صورة"}
          </button>
        )}
      </div>

      {/* Real colour picker (hex) — only for new / editable colours */}
      {onSetHex && !existingColorId && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10.5px] font-semibold text-muted-foreground">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(hex ?? "") ? hex!.toLowerCase() : "#000000"}
              onChange={(e) => onSetHex(e.target.value.toLowerCase())}
              className="h-7 w-9 cursor-pointer rounded-md border border-border bg-transparent p-0"
              aria-label="قيمة اللون الحقيقية (hex)"
              title="اختر القيمة البصرية الحقيقية للون"
            />
            اللون الحقيقي
          </label>
          <Input
            value={hex ?? ""}
            onChange={(e) =>
              onSetHex(e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)
            }
            placeholder="#000000"
            className="h-7 w-32 text-[11px] tabular-nums"
            aria-label="قيمة اللون (hex)"
          />
          <span className="text-[10px] text-muted-foreground">تُخزَّن هذه القيمة وتعرض كما هي</span>
        </div>
      )}

      {/* Autocomplete popover */}
      {open && matches.length > 0 && (
        <div className="relative">
          <div className="absolute right-0 top-0 z-20 mt-1 w-full max-w-[380px] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            <div className="border-b border-border bg-secondary/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              الألوان المسجّلة
            </div>
            {matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-right text-sm hover:bg-secondary"
              >
                <ColorSwatch color={c} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{c.name}</div>
                  <div className="truncate text-[10px] tabular-nums text-muted-foreground">
                    {c.code}
                  </div>
                </div>
                {c.id === existingColorId && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
