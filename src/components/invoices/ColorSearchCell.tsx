import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ImagePlus, Plus, Sparkles, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  colorByCode,
  colorByName,
  colors,
  fabricById,
  searchColors,
  type Color,
} from "@/presentation/hooks/useInventory";
import { ColorSwatch } from "@/components/common/ColorSwatch";
import { recentSuggestions } from "@/shared/utils/suggestions";

/**
 * Search-first colour picker.
 *
 * Focus/click with empty fields → the most recent colours (of the fabric when scoped).
 * Types a name/code → lists matching colours (never the whole catalogue).
 * A hit on another fabric copies the name; it does not bind that fabric's
 * color id. No match → "+ إضافة لون" and the parent creates a row on save.
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
  disabled,
  renameMode,
}: {
  name: string;
  code: string;
  hex?: string;
  existingColorId?: string;
  imageUrl?: string;
  fabricId?: string;
  onPickExisting: (color: Color) => void;
  onSetName: (name: string) => void;
  onSetCode: (code: string) => void;
  onSetHex?: (hex: string | undefined) => void;
  onSetImage?: (dataUrl: string | undefined) => void;
  disabled?: boolean;
  renameMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<"code" | "name">("code");
  const fileRef = useRef<HTMLInputElement>(null);

  const query = activeField === "code" ? code : name;
  const matches = useMemo(
    () =>
      query.trim()
        ? searchColors(query, 12, fabricId)
        : recentSuggestions(fabricId ? colors.filter((c) => c.fabricId === fabricId) : colors),
    // `colors` is a mutable module cache; its length changes when the list loads/grows.
    [query, fabricId, colors.length],
  );
  const localByCode = useMemo(() => colorByCode(code, fabricId), [code, fabricId]);
  const localByName = useMemo(() => colorByName(name, fabricId), [name, fabricId]);
  const local = localByCode ?? localByName;
  const matched = Boolean(existingColorId || local);
  const typed = code.trim().length > 0 || name.trim().length > 0;
  const isNew = typed && !matched;
  const createLabel = (name.trim() || code.trim() || "لون").trim();

  const pick = (c: Color) => {
    onPickExisting(c);
    setOpen(false);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") setOpen(false);
    if (e.key === "Enter" && local && !existingColorId) {
      e.preventDefault();
      pick(local);
    }
  };

  const handleFile = (file?: File) => {
    if (!file || !onSetImage) return;
    const reader = new FileReader();
    reader.onload = () => onSetImage(String(reader.result));
    reader.readAsDataURL(file);
  };

  const previewColor = existingColorId
    ? (localByCode ?? localByName)
    : (localByCode ?? localByName);
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

  const showMenu = open && !disabled && (matches.length > 0 || isNew);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2">
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

        <div className="relative">
          <Input
            value={code}
            onChange={(e) => {
              onSetCode(e.target.value);
              setActiveField("code");
              setOpen(true);
            }}
            onFocus={() => {
              if (disabled) return;
              setActiveField("code");
              setOpen(true);
            }}
            onClick={() => {
              if (disabled) return;
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
            disabled={disabled}
            aria-label="رقم اللون"
          />
        </div>

        <div className="relative">
          <Input
            value={name}
            onChange={(e) => {
              onSetName(e.target.value);
              setActiveField("name");
              setOpen(true);
            }}
            onFocus={() => {
              if (disabled) return;
              setActiveField("name");
              setOpen(true);
            }}
            onClick={() => {
              if (disabled) return;
              setActiveField("name");
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 140)}
            onKeyDown={handleKey}
            placeholder="ابحث أو اكتب اسم اللون..."
            className={cn("h-9", matched && "border-primary/40 bg-primary/[0.03]")}
            disabled={disabled}
            aria-label="اسم اللون"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10.5px]">
        {matched ? (
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
            <Check className="h-3 w-3" /> لون مسجّل لهذا القماش
          </span>
        ) : isNew ? (
          <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-semibold text-muted-foreground">
            <Sparkles className="h-3 w-3" />{" "}
            {renameMode
              ? "سيتم تحديث اسم اللون عند الحفظ"
              : `لا يوجد — سيُضاف «${createLabel}» عند الحفظ`}
          </span>
        ) : (
          <span className="text-muted-foreground">اختر من الألوان المسجّلة أو اكتب للبحث</span>
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
        </div>
      )}

      {showMenu && (
        <div className="relative">
          <div className="absolute right-0 top-0 z-20 mt-1 w-full max-w-[380px] overflow-hidden rounded-md border border-border bg-popover shadow-lg">
            <div className="border-b border-border bg-secondary/40 px-3 py-1 text-[10px] font-semibold text-muted-foreground">
              نتائج البحث
            </div>
            {matches.map((c) => {
              const fab = fabricById(c.fabricId);
              const sameFabric = fabricId ? c.fabricId === fabricId : false;
              return (
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
                    <div className="truncate text-[10px] text-muted-foreground">
                      {fab?.name ?? "قماش"}
                      {c.code ? ` · ${c.code}` : ""}
                      {!sameFabric && fabricId ? " — يُنسخ الاسم لهذا القماش" : ""}
                    </div>
                  </div>
                  {c.id === existingColorId && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              );
            })}
            {isNew && (
              <div className="flex items-center gap-2 border-t border-border bg-primary/5 px-3 py-2 text-[12px] font-semibold text-primary">
                <Plus className="h-3.5 w-3.5" />
                إضافة لون «{createLabel}»
                <span className="font-normal text-muted-foreground">— يُحفظ مع الفاتورة</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
