import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ProfitLossEndpoint,
  SalesReportEndpoint,
  InventoryReportEndpoint,
  CustomerStatementEndpoint,
  SupplierStatementEndpoint,
  TaxReportEndpoint,
  CashFlowReportEndpoint,
  FORBIDDEN_PHANTOM_REPORT_PATHS,
  SHIPPED_REPORT_ENDPOINTS,
  UNSHIPPED_REPORT_PLACEHOLDERS,
} from "./reports";

describe("DFP-015 report contracts align with mounted APIs", () => {
  it("does not declare phantom /api/reports/* paths", () => {
    const paths = [
      ...SHIPPED_REPORT_ENDPOINTS.map((e) => e.path),
      ...UNSHIPPED_REPORT_PLACEHOLDERS.map((e) => e.path),
    ];
    for (const p of paths) {
      expect(FORBIDDEN_PHANTOM_REPORT_PATHS).not.toContain(p);
      expect(p.startsWith("/api/reports/")).toBe(false);
    }
  });

  it("shipped endpoints are the five live surfaces", () => {
    expect(SHIPPED_REPORT_ENDPOINTS).toHaveLength(5);
    expect(ProfitLossEndpoint.path).toBe("/api/profit/summary");
    expect(SalesReportEndpoint.path).toBe("/api/dashboard");
    expect(InventoryReportEndpoint.path).toBe("/api/rolls");
    expect(CustomerStatementEndpoint.path).toBe("/api/customers/:id/statement");
    expect(SupplierStatementEndpoint.path).toBe("/api/suppliers/:id/statement");
  });

  it("tax/cash-flow stay unshipped placeholders", () => {
    expect(UNSHIPPED_REPORT_PLACEHOLDERS).toContain(TaxReportEndpoint);
    expect(UNSHIPPED_REPORT_PLACEHOLDERS).toContain(CashFlowReportEndpoint);
    expect(TaxReportEndpoint.description).toMatch(/UNSHIPPED/);
    expect(CashFlowReportEndpoint.description).toMatch(/UNSHIPPED/);
  });

  it("backend server mounts each shipped route family", () => {
    const server = readFileSync(
      resolve(process.cwd(), "backend/src/presentation/server.ts"),
      "utf8",
    );
    expect(server).toMatch(/registerProfitRoutes/);
    expect(server).toMatch(/registerDashboardRoutes/);
    expect(server).toMatch(/registerRollRoutes/);
    expect(server).toMatch(/registerStatementRoutes/);
  });
});
