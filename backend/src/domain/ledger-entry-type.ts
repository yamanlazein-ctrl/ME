/**
 * Single source of truth for ledger entry types.
 *
 * Every code path that writes to `ledger_entries` must use one of these
 * literals. The same array drives the database CHECK constraint so the
 * allowed set cannot drift from the application again.
 */
export const LEDGER_ENTRY_TYPES = [
  "adjustment",
  "adjustment_contra",
  "cancellation",
  "cash",
  "cogs_expense",
  "expense",
  "inventory_asset",
  "opening",
  "opening_equity",
  "payment_out",
  "printing_charge",
  "printing_revenue",
  "purchase_invoice",
  "purchase_return",
  "purchase_return_contra",
  "receipt_in",
  "sales_invoice",
  "sales_revenue",
  "sales_return",
  "sales_return_contra",
  "settlement",
  "settlement_contra",
  /** Receipt: Dr when customer pays less cash but full settlement is credited. */
  "settlement_discount_expense",
  /** Payment: Cr when supplier accepts less cash but AP is debited in full. */
  "settlement_discount_income",
  /** FX-FREEZE: realized gain when a cross-currency voucher settles an invoice at
   *  a rate more favorable than the invoice's own frozen rate (base credit). */
  "fx_gain",
  /** FX-FREEZE: realized loss when the settlement rate is less favorable than the
   *  invoice's frozen rate (base debit). Balances the base-currency ledger. */
  "fx_loss",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** Validate at runtime; useful for zod/contract tests. */
export function isLedgerEntryType(value: string): value is LedgerEntryType {
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(value);
}
