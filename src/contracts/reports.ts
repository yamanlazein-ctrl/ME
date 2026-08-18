import type { EndpointMeta, ApiError } from "./_shared";

export interface ReportParams {
  fromDate?: string;
  toDate?: string;
  partyId?: string;
  currency?: string;
  groupBy?: "day" | "week" | "month" | "year";
  format?: "json" | "csv" | "pdf";
}

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
  path: "/api/reports/profit-loss",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Profit & loss statement for a date range",
};

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
  path: "/api/reports/sales",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Sales summary report",
};

export interface InventoryReport {
  totalRolls: number;
  totalKg: number;
  lowStockRolls: number;
  outOfStockRolls: number;
  byFabric: Array<{ fabricId: string; fabricName: string; totalKg: number; rollCount: number }>;
}
export type InventoryReportError = ApiError;
export const InventoryReportEndpoint: EndpointMeta = {
  path: "/api/reports/inventory",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse"] },
  description: "Inventory status report",
};

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
  path: "/api/reports/customer-statement/:partyId",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Customer account statement",
};

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
  path: "/api/reports/supplier-statement/:partyId",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Supplier account statement",
};

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
  path: "/api/reports/tax",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Tax summary report",
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
  path: "/api/reports/cash-flow",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cash flow report",
};
