import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invalidateFinancialViews } from "./invalidateFinancialViews";

// The helper also refreshes useParties' module cache (FE-02); keep the real container out of this test.
const refreshParties = vi.fn(() => Promise.resolve());
vi.mock("./useParties", () => ({ refreshParties: () => refreshParties() }));

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
      "parties",
      "invoices",
      "documents",
    ]);
    expect(refreshParties).toHaveBeenCalled();
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
      "parties",
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
      "parties",
      "invoices",
    ] as const) {
      expect(qc.getQueryState([key])?.isInvalidated, key).toBe(true);
    }
  });

  it("invalidates every filtered tracking total and the invoice used by an open preview", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const keys = [
      ["documents", "track", { type: "entry", page: 0 }],
      ["documents", "track", { type: "sale", page: 2 }],
      ["invoices", "detail", "edited-invoice"],
      ["statement", "customer"],
    ];
    for (const key of keys) qc.setQueryData(key, { total: 1000 });
    qc.setQueryData(["documents", "unrelated"], { keep: true });
    invalidateFinancialViews(qc);
    for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["documents", "unrelated"])?.isInvalidated).toBe(false);
    qc.clear();
  });

  it("refetches active tracking totals and replaces the open preview's invoice after a weight edit", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    let quantity = 100;
    const detailKey = ["invoices", "detail", "edited-invoice"];
    const trackKey = ["documents", "track", { type: "entry", page: 0 }];
    const fetchDetail = async () => ({ id: "edited-invoice", quantity, total: quantity * 10 });
    const fetchTrack = async () => ({ data: [{ id: "edited-invoice", total: quantity * 10 }] });
    qc.setQueryData(detailKey, await fetchDetail());
    qc.setQueryData(trackKey, await fetchTrack());
    const detail = new QueryObserver(qc, { queryKey: detailKey, queryFn: fetchDetail });
    const tracking = new QueryObserver(qc, { queryKey: trackKey, queryFn: fetchTrack });
    const stopDetail = detail.subscribe(() => {});
    const stopTracking = tracking.subscribe(() => {});
    try {
      expect(detail.getCurrentResult().data?.total).toBe(1000);
      expect(tracking.getCurrentResult().data?.data[0].total).toBe(1000);
      quantity = 40;
      invalidateFinancialViews(qc);
      await vi.waitFor(() => {
        expect(detail.getCurrentResult().data).toMatchObject({ quantity: 40, total: 400 });
        expect(tracking.getCurrentResult().data?.data[0].total).toBe(400);
      });
    } finally {
      stopDetail();
      stopTracking();
      qc.clear();
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
