import type { EndpointMeta } from "./_shared";

/**
 * Frontend contracts mirroring backend/src/domain/entities/Profit.ts.
 *
 * STRICT ACCOUNTING EQUATION (server-computed — never recomputed/mixed here):
 *   netProfit = salesRevenue − cogs − expenses   (per currency, never blended)
 *
 * Receivables/payables are ASSETS/LIABILITIES — displayed separately,
 * NEVER subtracted from profit.
 */

export interface ProfitSummaryByCurrencyDTO {
  currency: string;
  salesRevenue: number;
  cogs: number;
  expenses: number;
  /** grossProfit = salesRevenue − cogs */
  grossProfit: number;
  /** netProfit = salesRevenue − cogs − expenses */
  netProfit: number;
  marginPercent: number;
  invoiceCount: number;
}

export interface DebtItemDTO {
  invoiceId: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  currency: string;
  total: number;
  paid: number;
  returns: number;
  /** remaining = total − paid − returns */
  remaining: number;
  kind: "receivable" | "payable";
  daysOverdue: number;
}

export interface ProfitDetailLineDTO {
  invoiceId: string;
  number: string;
  date: string;
  partyId: string;
  partyName: string;
  currency: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPercent: number;
}

export interface ProfitSummaryDTO {
  byCurrency: ProfitSummaryByCurrencyDTO[];
  totalReceivables: DebtItemDTO[];
  totalPayables: DebtItemDTO[];
}

export interface ProfitExpenseRowDTO {
  id: string;
  number: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
}

export interface ProfitDetailsDTO {
  byCurrency: ProfitSummaryByCurrencyDTO[];
  invoiceLines: ProfitDetailLineDTO[];
  expenses: ProfitExpenseRowDTO[];
  receivables: DebtItemDTO[];
  payables: DebtItemDTO[];
}

export interface ProfitQueryParams {
  fromDate?: string; // yyyy-mm-dd
  toDate?: string; // yyyy-mm-dd
  currency?: string; // omitted ⇒ every currency returned separately
}

export type GetProfitSummaryResponse = ProfitSummaryDTO;
export type GetProfitSummaryError = Error;

export const GetProfitSummaryEndpoint: EndpointMeta = {
  path: "/api/profit/summary",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Aggregated profit summary for a period, grouped per currency",
};

export type GetProfitDetailsResponse = ProfitDetailsDTO;
export type GetProfitDetailsError = Error;

export const GetProfitDetailsEndpoint: EndpointMeta = {
  path: "/api/profit/details",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Per-invoice profit breakdown + expenses + debts for a period",
};