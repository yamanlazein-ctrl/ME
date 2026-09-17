import { convertForSettlement, isValidFxRate } from "@erp/shared";
import { BusinessRuleError } from "../errors/index.js";

/**
 * Convert one sale line's roll-native-currency COGS into the invoice's
 * currency. Extracted from PostgresInvoiceRepository's create()/update() —
 * both had this identical logic duplicated inline.
 *
 * F02 (Phase 1 foundation audit): cross-currency COGS must NEVER silently
 * substitute a synthetic rate (e.g. treating SYP-costed stock as if it were
 * already 1:1 USD) — that produced a COGS magnitude wildly wrong relative to
 * reality (6.8kg of SYP-costed stock read as 9.07 USD while the SYP
 * quantity stayed in the GL). A manual exchange rate is REQUIRED whenever
 * the roll's currency differs from the invoice's currency; absent a valid
 * one, this fails closed with a BusinessRuleError instead of guessing.
 */
export function resolveSaleLineCogs(
  rollCostNative: number,
  rollCurrency: string,
  invoiceCurrency: string,
  manualExchangeRate: number | null | undefined,
): number {
  if (rollCurrency === invoiceCurrency) {
    return rollCostNative;
  }
  const rate = isValidFxRate(manualExchangeRate) ? manualExchangeRate! : null;
  const converted = convertForSettlement(rollCostNative, rollCurrency, invoiceCurrency, rate);
  if (converted === null) {
    throw new BusinessRuleError(
      `سعر الصرف مطلوب يدوياً لبيع صبغة بعملة (${rollCurrency}) بفاتورة (${invoiceCurrency})`,
    );
  }
  return converted;
}
