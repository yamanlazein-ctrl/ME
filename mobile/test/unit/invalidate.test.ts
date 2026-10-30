import { describe, expect, it } from "vitest";
import { invalidateFinancialViews } from "../../src/hooks/invalidate";
import { queryKeys } from "../../src/hooks/queryKeys";

describe("invalidateFinancialViews (FR-09, FR-13)", () => {
  it("invalidates dashboard, parties, statements, cashbox, invoices and sync", async () => {
    const keys: unknown[] = [];
    const invalidateQueries = async (f?: { queryKey?: readonly unknown[] }) => {
      keys.push(f?.queryKey);
    };
    await invalidateFinancialViews({ invalidateQueries });
    expect(keys).toEqual(
      expect.arrayContaining([
        queryKeys.dashboard,
        queryKeys.parties,
        ["statements"],
        queryKeys.cashbox,
        queryKeys.invoices,
        queryKeys.sync,
      ]),
    );
  });
});
