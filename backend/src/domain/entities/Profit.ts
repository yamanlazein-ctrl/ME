/**
 * Profit domain entity — represents the accounting result of a period.
 *
 * STRICT ACCOUNTING EQUATION (never deviate):
 *   netProfit = salesRevenue − COGS − expenses
 *
 * Where (period attribution — OLD-PLAN / business decision 2ب):
 *   salesRevenue = Σ(active SALE invoices with invoice.date in period: subtotal − discount)
 *                − Σ(active SALE returns with returns.date in period: qty × price)
 *   COGS         = Σ(posted cogs_expense on those period invoices, else qty × invoice_lines.cost_per_kg)
 *                − Σ(posted COGS reversal on returns dated in the period)
 *   expenses     = SUM(expenses.amount) for active expenses with expense.date in period
 *
 * Return effects follow **returns.date**, not the original invoice date.
 * A 2027 return of a 2024 invoice reduces 2027 profit only.
 *
 * COGS never re-reads live rolls.price_per_kg for historical reports — cost_per_kg
 * (and/or posted ledger COGS) is authoritative after migration 20261008.
 *
 * CRITICAL: Receivables/payables (ذمم مدينة/دائنة) are ASSETS/LIABILITIES,
 * NOT expenses. They are NEVER subtracted from net profit.
 *
 * Multi-currency: every monetary figure is grouped per currency. Currencies
 * are NEVER mixed, summed, or converted server-side.
 */

/** A single invoice's profit contribution within the period. */
export interface ProfitDetailLine {
  invoiceId: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  currency: string;
  /** Revenue = subtotal − discount (excludes tax + shipping). Period returns are applied at summary level. */
  revenue: number;
  /** Cost of goods sold for this invoice (posted ledger or cost_per_kg snapshot). */
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
  total: number;
  paid: number;
  returns: number;
  remaining: number;
  kind: "receivable" | "payable";
  daysOverdue: number;
}

/** Aggregated profit summary for a period, per currency. */
export interface ProfitSummaryByCurrency {
  currency: string;
  salesRevenue: number;
  cogs: number;
  expenses: number;
  netProfit: number;
  grossProfit: number;
  marginPercent: number;
  invoiceCount: number;
  /** Active sale returns whose returns.date falls in the period (any original invoice). */
  returnCount?: number;
}

export interface ProfitSummary {
  byCurrency: ProfitSummaryByCurrency[];
  totalReceivables: DebtItem[];
  totalPayables: DebtItem[];
}

export interface ProfitDetails {
  byCurrency: ProfitSummaryByCurrency[];
  invoiceLines: ProfitDetailLine[];
  /** Period-dated return adjustments (may reference invoices outside the invoice-date window). */
  returnAdjustments?: Array<{
    returnId: string;
    number: string;
    date: string;
    originalInvoiceId: string | null;
    currency: string;
    revenue: number;
    cogs: number;
  }>;
  expenses: Array<{
    id: string;
    number: string;
    date: string;
    category: string;
    description: string;
    amount: number;
    currency: string;
  }>;
  receivables: DebtItem[];
  payables: DebtItem[];
}

export interface ProfitQuery {
  fromDate?: string;
  toDate?: string;
  currency?: string;
}
