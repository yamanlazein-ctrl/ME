/**
 * Profit domain entity — represents the accounting result of a period.
 *
 * STRICT ACCOUNTING EQUATION (never deviate):
 *   netProfit = salesRevenue − COGS − expenses
 *
 * Where:
 *   salesRevenue = SUM(invoices.subtotal − invoices.discount)  for active SALE invoices
 *   COGS         = SUM(invoice_lines.quantityKg × COALESCE(invoice_lines.costPer_kg, rolls.price_per_kg))
 *                 for the same active SALE invoices (costPerKg snapshot is authoritative)
 *   expenses     = SUM(expenses.amount) for active expenses in the period
 *
 * CRITICAL: Receivables/payables (ذمم مدينة/دائنة) are ASSETS/LIABILITIES,
 * NOT expenses. They are NEVER subtracted from net profit. They are reported
 * in a separate `debts` section for display only.
 *
 * Multi-currency: every monetary figure is grouped per currency. Currencies
 * are NEVER mixed, summed, or converted server-side. Each currency bucket
 * is computed independently.
 */

/** A single invoice's profit contribution within the period. */
export interface ProfitDetailLine {
  invoiceId: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  currency: string;
  /** Revenue = subtotal − discount (excludes tax + shipping, per P0-LOGIC-3.6d). */
  revenue: number;
  /** Cost of goods sold = SUM(qty × costPerKg snapshot) for this invoice's lines. */
  cogs: number;
  /** Gross profit = revenue − cogs. Expenses are NOT allocated per-invoice. */
  grossProfit: number;
  marginPercent: number;
}

/** A receivable/payable item — displayed separately, never subtracted from profit. */
export interface DebtItem {
  invoiceId: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  currency: string;
  /** invoice.total */
  total: number;
  /** amount already paid (via vouchers + invoice.paid) */
  paid: number;
  /** returns amount (sale returns reduce receivables; entry returns reduce payables) */
  returns: number;
  /** remaining = total − paid − returns */
  remaining: number;
  /** "receivable" (customer owes us) or "payable" (we owe supplier). */
  kind: "receivable" | "payable";
  daysOverdue: number;
}

/** Aggregated profit summary for a period, per currency. */
export interface ProfitSummaryByCurrency {
  currency: string;
  salesRevenue: number;
  cogs: number;
  expenses: number;
  /** netProfit = salesRevenue − cogs − expenses */
  netProfit: number;
  /** grossProfit = salesRevenue − cogs (before expenses). */
  grossProfit: number;
  marginPercent: number;
  invoiceCount: number;
}

export interface ProfitSummary {
  byCurrency: ProfitSummaryByCurrency[];
  /** Total receivables across all currencies (never subtracted from profit). */
  totalReceivables: DebtItem[];
  /** Total payables across all currencies (never subtracted from profit). */
  totalPayables: DebtItem[];
}

export interface ProfitDetails {
  byCurrency: ProfitSummaryByCurrency[];
  /** Per-invoice profit breakdown (sale invoices only). */
  invoiceLines: ProfitDetailLine[];
  /** Expenses in the period (for the details drill-down). */
  expenses: Array<{
    id: string;
    number: string;
    date: string;
    category: string;
    description: string;
    amount: number;
    currency: string;
  }>;
  /** Receivables (customer debts) — never subtracted from profit. */
  receivables: DebtItem[];
  /** Payables (supplier debts) — never subtracted from profit. */
  payables: DebtItem[];
}

export interface ProfitQuery {
  fromDate?: string;
  toDate?: string;
  currency?: string;
}
