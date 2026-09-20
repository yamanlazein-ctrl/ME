import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invalidateFinancialViews } from "./invalidateFinancialViews";

describe("invalidateFinancialViews (DFP-016/017)", () => {
  it("invalidates every financial query family", () => {
    const invalidateQueries = vi.fn();
    const refetchQueries = vi.fn();
    const qc = { invalidateQueries, refetchQueries } as never;

    invalidateFinancialViews(qc);

    const keys = invalidateQueries.mock.calls.map((c) => c[0].queryKey[0]);
    expect(keys).toEqual([
      "dashboard",
      "cashbox",
      "ledger",
      "profit",
      "statement",
      "party",
      "invoices",
    ]);
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it("optionally refetches dashboard", () => {
    const invalidateQueries = vi.fn();
    const refetchQueries = vi.fn();
    const qc = { invalidateQueries, refetchQueries } as never;

    invalidateFinancialViews(qc, { refetchDashboard: true });
    expect(refetchQueries).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });

  it("QueryClient marks dependent caches invalidated after party/order-style mutation", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    for (const key of [
      "dashboard",
      "cashbox",
      "ledger",
      "profit",
      "statement",
      "party",
      "invoices",
    ] as const) {
      qc.setQueryData([key], { seed: key });
    }
    invalidateFinancialViews(qc);
    for (const key of [
      "dashboard",
      "cashbox",
      "ledger",
      "profit",
      "statement",
      "party",
      "invoices",
    ] as const) {
      expect(qc.getQueryState([key])?.isInvalidated, key).toBe(true);
    }
  });

  it("useParties create/update call invalidateFinancialViews", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/presentation/hooks/useParties.ts"),
      "utf8",
    );
    expect(src).toMatch(/invalidateFinancialViews/);
    expect(src.match(/invalidateFinancialViews/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("useOrders create/cancel/fulfill call invalidateFinancialViews", () => {
    const src = readFileSync(resolve(process.cwd(), "src/presentation/hooks/useOrders.ts"), "utf8");
    expect(src).toMatch(/invalidateFinancialViews/);
    expect(src.match(/invalidateFinancialViews/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
