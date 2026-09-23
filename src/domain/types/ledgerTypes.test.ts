import { describe, expect, it } from "vitest";
import { FRONTEND_LEDGER_TYPES } from "./index";

/** Must match backend/src/domain/ledger-entry-type.ts LEDGER_ENTRY_TYPES (REPAIR-011). */
const BACKEND_LEDGER_ENTRY_TYPES = [
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
  "settlement_discount_expense",
  "settlement_discount_income",
  "fx_gain",
  "fx_loss",
] as const;

describe("LedgerType parity (REPAIR-011)", () => {
  it("frontend union equals backend LEDGER_ENTRY_TYPES", () => {
    expect([...FRONTEND_LEDGER_TYPES].sort()).toEqual([...BACKEND_LEDGER_ENTRY_TYPES].sort());
  });
});
