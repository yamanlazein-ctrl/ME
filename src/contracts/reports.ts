/**
 * Report API contracts (DFP-015).
 *
 * These paths MUST match mounted backend routes. Phantom `/api/reports/*`
 * endpoints were removed — they were never registered on the server and
 * produced 404s. Consumers must use the live profit / statement / dashboard
 * surfaces documented below (and in their dedicated contract modules).
 */
import type { EndpointMeta, ApiError } from "./_shared";

export interface ReportParams {
  fromDate?: string;
  toDate?: string;
  partyId?: string;
  currency?: string;
  groupBy?: "day" | "week" | "month" | "year";
  format?: "json" | "csv" | "pdf";
}

/** @see backend `GET /api/profit/summary` */
export interface ProfitLossReport {
  totalSales: number;
  totalReturns: number;
  totalExpenses: number;
  netProfit: number;
  currency: string;
  fromDate: string;
  toDate: string;
}
export type ProfitLossError = ApiError;
export const ProfitLossEndpoint: EndpointMeta = {
  path: "/api/profit/summary",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Profit summary for a date range (mounted profit.route)",
};

/** Dashboard aggregates cover sales-style KPI reads used by the ERP UI. */
export interface SalesReport {
  totalSales: number;
  invoiceCount: number;
  averagePerInvoice: number;
  byCurrency: Record<string, number>;
  topCustomers: Array<{ partyId: string; partyName: string; total: number }>;
  fromDate: string;
  toDate: string;
}
export type SalesReportError = ApiError;
export const SalesReportEndpoint: EndpointMeta = {
  path: "/api/dashboard",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Dashboard KPIs including sales aggregates (mounted dashboard.route)",
};

/** Inventory status is served by rolls/fabrics list endpoints, not a report hub. */
export interface InventoryReport {
  totalRolls: number;
  totalKg: number;
  lowStockRolls: number;
  outOfStockRolls: number;
  byFabric: Array<{ fabricId: string; fabricName: string; totalKg: number; rollCount: number }>;
}
export type InventoryReportError = ApiError;
export const InventoryReportEndpoint: EndpointMeta = {
  path: "/api/rolls",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse"] },
  description: "Roll inventory list (use /api/fabrics for fabric grouping)",
};

/** @see src/contracts/statement.ts GetCustomerStatementEndpoint */
export interface CustomerStatementReport {
  partyId: string;
  partyName: string;
  openingBalance: number;
  transactions: Array<{
    date: string;
    type: string;
    reference: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
  closingBalance: number;
  fromDate: string;
  toDate: string;
}
export type CustomerStatementError = ApiError;
export const CustomerStatementEndpoint: EndpointMeta = {
  path: "/api/customers/:id/statement",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Customer statement (mounted statement.route)",
};

/** @see src/contracts/statement.ts GetSupplierStatementEndpoint */
export interface SupplierStatementReport {
  partyId: string;
  partyName: string;
  openingBalance: number;
  transactions: Array<{
    date: string;
    type: string;
    reference: string;
    debit: number;
    credit: number;
    balance: number;
  }>;
  closingBalance: number;
  fromDate: string;
  toDate: string;
}
export type SupplierStatementError = ApiError;
export const SupplierStatementEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id/statement",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Supplier statement (mounted statement.route)",
};

/**
 * Tax / cash-flow dedicated hubs are not shipped (DFP-015).
 * Kept as typed placeholders so UI drafts compile — NOT part of
 * `SHIPPED_REPORT_ENDPOINTS` and must not be called as release contracts.
 */
export interface TaxReport {
  totalSales: number;
  totalPurchases: number;
  taxableAmount: number;
  taxCollected: number;
  taxPaid: number;
  netTaxDue: number;
  fromDate: string;
  toDate: string;
}
export type TaxReportError = ApiError;
export const TaxReportEndpoint: EndpointMeta = {
  path: "/api/profit/details",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description:
    "UNSHIPPED placeholder — dedicated tax report not implemented; do not treat as a release contract",
};

export interface CashFlowReport {
  totalIn: number;
  totalOut: number;
  netFlow: number;
  byDay: Array<{ date: string; in: number; out: number; balance: number }>;
  fromDate: string;
  toDate: string;
}
export type CashFlowReportError = ApiError;
export const CashFlowReportEndpoint: EndpointMeta = {
  path: "/api/cashbox",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description:
    "UNSHIPPED placeholder — dedicated cash-flow report not implemented; do not treat as a release contract",
};

/** Shipped report surfaces that must match mounted backend routes (DFP-015). */
export const SHIPPED_REPORT_ENDPOINTS = [
  ProfitLossEndpoint,
  SalesReportEndpoint,
  InventoryReportEndpoint,
  CustomerStatementEndpoint,
  SupplierStatementEndpoint,
] as const;

/** Explicitly out of release scope until dedicated routes exist. */
export const UNSHIPPED_REPORT_PLACEHOLDERS = [
  TaxReportEndpoint,
  CashFlowReportEndpoint,
] as const;

/** Paths that must NEVER appear as mounted report hubs (regression for DFP-015). */
export const FORBIDDEN_PHANTOM_REPORT_PATHS = [
  "/api/reports/profit-loss",
  "/api/reports/sales",
  "/api/reports/inventory",
  "/api/reports/customer-statement/:partyId",
  "/api/reports/supplier-statement/:partyId",
  "/api/reports/tax",
  "/api/reports/cash-flow",
] as const;
