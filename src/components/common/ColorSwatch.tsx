import { cn } from "@/lib/utils";
import type { Color } from "@/presentation/hooks/useInventory";
import { safeHexColor } from "@/shared/utils/color";

/**
 * Small colour identifier.
 *
 * Priority order (single source of truth = the stored colour value):
 *   1. `color.hex`     → the real visual colour stored in the DB
 *   2. `color.imageUrl`→ uploaded swatch image (if a real hex wasn't chosen)
 *   3. neutral fallback→ a safe, neutral grey so NO fake/hash colour is ever shown
 *
 * We deliberately do NOT derive a colour from `code`/`name` (no hash). If a
 * legacy colour has neither a hex nor an image, a neutral placeholder is shown
 * until a real value is set.
 */
const NEUTRAL_FALLBACK = "#d1d5db"; // gray-300 — neutral, not misleading

export function ColorSwatch({
  color,
  size = "md",
  className,
}: {
  color?: Pick<Color, "code" | "name" | "imageUrl" | "hex"> | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const sizeCls =
    size === "xs"
      ? "h-5 w-5 rounded-md border"
      : size === "sm"
        ? "h-6 w-6 rounded-md border"
        : size === "lg"
          ? "h-10 w-10 rounded-lg border-2"
          : "h-8 w-8 rounded-lg border-2";

  if (!color) {
    return (
      <div
        className={cn(
          "shrink-0 border-dashed border-border bg-muted/30",
          sizeCls,
          className,
        )}
      />
    );
  }

  const title = `${color.name}${color.code ? ` (${color.code})` : ""}${
    color.hex ? ` — ${color.hex}` : ""
  }`;

  // 1. Real stored hex takes priority (sanitized). Invalid/malformed values
  //    (e.g. "jkjlj") degrade to a neutral grey instead of breaking render.
  if (color.hex) {
    return (
      <div
        className={cn(
          "shrink-0 border-border shadow-inner",
          sizeCls,
          className,
        )}
        style={{ background: safeHexColor(color.hex) }}
        title={title}
      />
    );
  }

  // 2. Uploaded image as fallback for colours without a stored hex.
  if (color.imageUrl) {
    return (
      <img
        src={color.imageUrl}
        alt={color.name}
        title={title}
        className={cn(
          "shrink-0 border-border object-cover shadow-inner",
          sizeCls,
          className,
        )}
      />
    );
  }

  // 3. Neutral placeholder — never a fake hash colour.
  return (
    <div
      className={cn("shrink-0 border-border shadow-inner", sizeCls, className)}
      style={{ background: NEUTRAL_FALLBACK }}
      title={title}
    />
  );
}
