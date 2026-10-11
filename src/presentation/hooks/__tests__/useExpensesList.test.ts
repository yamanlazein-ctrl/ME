import { describe, it, expect, vi, beforeEach } from "vitest";
import { listExpensesSchema } from "../../../../packages/shared/src/schemas/expense.schema";

// FE-03 / FE-04 / FE-06: the expenses list must be server-paged with the true total, and every filter
// key it sends must be one the API accepts — the screen sent `from`/`to`, which the API's schema
// silently strips (it reads `fromDate`/`toDate`), so the date filter never applied.
const page = vi.fn();
vi.mock("@/infrastructure/container", () => ({
  container: { expenses: { list: { page: (f: unknown) => page(f), execute: vi.fn() } } },
}));
let lastQuery: { queryFn: (c: { signal?: AbortSignal }) => Promise<unknown> } | undefined;
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: typeof lastQuery) => ((lastQuery = o), { data: undefined }),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

import { useExpensesList } from "../useExpenses";

beforeEach(() => {
  page.mockReset();
  page.mockResolvedValue({ data: [{ id: "e1" }], total: 25, hasNext: true });
});

describe("useExpensesList", () => {
  it("returns one server page with the true total", async () => {
    useExpensesList({ page: 1 });
    const r = await lastQuery!.queryFn({});
    expect(r).toEqual({ data: [{ id: "e1" }], total: 25, hasNext: true });
    expect(page).toHaveBeenCalledWith({ page: 1 });
  });

  it("sends only filter keys the API schema accepts (date window, search, paging)", async () => {
    useExpensesList({
      category: "إيجار",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
      search: "كهرباء",
      page: 0,
      limit: 20,
    });
    await lastQuery!.queryFn({});
    const sent = page.mock.calls[0][0] as Record<string, unknown>;
    expect(() => listExpensesSchema.strict().parse(sent)).not.toThrow();
    expect(sent).toMatchObject({ fromDate: "2026-03-01", toDate: "2026-03-31", search: "كهرباء" });
  });
});
