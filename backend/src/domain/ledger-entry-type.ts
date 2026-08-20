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
  "receipt_in",
  "sales_invoice",
  "sales_revenue",
  "sales_return",
  "settlement",
  "settlement_contra",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/** Validate at runtime; useful for zod/contract tests. */
export function isLedgerEntryType(value: string): value is LedgerEntryType {
  return (LEDGER_ENTRY_TYPES as readonly string[]).includes(value);
}
