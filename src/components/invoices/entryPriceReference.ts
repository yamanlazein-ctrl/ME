import type { Currency } from "@/domain/types";
import type { RollData } from "@/domain/entities/Roll";

export interface EntryPriceReference {
  pricePerKg: number;
  currency: Currency;
  /** Where the price comes from, e.g. «فاتورة شراء ENT-2026-0012». */
  sourceLabel: string;
  entryDate: string;
  /** Sale price below the entry price — only decided when both are in the same currency. */
  belowEntry: boolean;
  /** The sale is in another currency, so the two prices are not compared (no FX guess). */
  otherCurrency: boolean;
}

type EntryRoll = Pick<
  RollData,
  "entryPricePerKg" | "entryCurrency" | "entrySource" | "entryReference" | "entryDate"
>;

/**
 * The price the selected roll (exact fabric + color + dye) actually entered stock at, as a reference
 * for the sales price. Returns null when no real entry price was recorded — never an estimate, an
 * average or another roll's price. It never changes the sale price.
 */
export function entryPriceReference(
  roll: EntryRoll | null | undefined,
  saleCurrency: Currency | "",
  salePricePerKg: number,
): EntryPriceReference | null {
  if (!roll) return null;
  const price = roll.entryPricePerKg;
  if (price == null || !Number.isFinite(price) || price <= 0 || !roll.entryCurrency) return null;
  const ref = roll.entryReference ? ` ${roll.entryReference}` : "";
  const sourceLabel =
    roll.entrySource === "purchase"
      ? `فاتورة شراء${ref}`
      : roll.entrySource === "press"
        ? `استلام من المطبعة${ref}`
        : "إدخال مباشر للمخزون";
  const otherCurrency = saleCurrency !== "" && saleCurrency !== roll.entryCurrency;
  return {
    pricePerKg: price,
    currency: roll.entryCurrency,
    sourceLabel,
    entryDate: roll.entryDate,
    belowEntry: !otherCurrency && saleCurrency !== "" && salePricePerKg > 0 && salePricePerKg < price,
    otherCurrency,
  };
}
