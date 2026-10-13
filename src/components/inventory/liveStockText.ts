import { formatQuantity } from "@/shared/utils/formatNumber";

export type LiveStockState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; pieces: number | null; kg: number };

/** Pure: what the hint says. Never falls back to a cached or default number. */
export function liveStockText(s: LiveStockState): string | null {
  switch (s.kind) {
    case "none":
      return null;
    case "loading":
      return "الموجود بالمخزون الآن: … جارٍ القراءة";
    case "unavailable":
      return "تعذّرت قراءة المخزون الآن";
    case "ready":
      return s.pieces == null
        ? `الموجود بالمخزون الآن: ${formatQuantity(s.kg)} كغ`
        : `الموجود بالمخزون الآن: ${s.pieces} ثوب — ${formatQuantity(s.kg)} كغ`;
  }
}
