/**
 * N-06 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the orders page rendered
 * `useOrdersList()` with no filter, so the repository's default `limit ?? 20`
 * silently truncated the list to the first 20 orders. The hook must pass the
 * caller's `page` through to the repository (both repos support `filter.page`),
 * and the queryKey must include it so each page caches separately.
 *
 * RED first: against the unmodified hook + OrderFilter (which only has
 * `offset`, not `page`) this fails to compile at `{ page: 2 }`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listExecute = vi.fn();
/** Captured useQuery options from the last hook call. */
let capturedOptions:
  | {
      queryKey: readonly unknown[];
      queryFn: (ctx: Record<string, unknown>) => Promise<unknown>;
    }
  | undefined;

vi.mock("@/infrastructure/container", () => ({
  container: {
    orders: {
      list: { execute: (...args: unknown[]) => listExecute(...args) },
      repository: { findById: vi.fn() },
    },
  },
}));
vi.mock("@/presentation/hooks/useInventory", () => ({
  rolls: [],
  refreshInventory: vi.fn(),
}));
vi.mock("@/infrastructure/di/auth-context", () => ({
  buildTenantContext: () => ({ tenantId: "t-1", userId: "u-1", userRole: "admin" }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (o: {
      queryKey: readonly unknown[];
      queryFn: (ctx: Record<string, unknown>) => Promise<unknown>;
    }) => {
      capturedOptions = o;
      return { data: undefined, isLoading: true } as never;
    },
  };
});

import type { QueryFunctionContext } from "@tanstack/react-query";
import { useOrdersList } from "./useOrders";

/** Invoke the hook, then run the queryFn it handed to useQuery. */
async function runListQueryFn(filter: Parameters<typeof useOrdersList>[0]) {
  capturedOptions = undefined;
  useOrdersList(filter);
  const captured = capturedOptions as
    | {
        queryKey: readonly unknown[];
        queryFn: (ctx: Record<string, unknown>) => Promise<unknown>;
      }
    | undefined;
  if (!captured) throw new Error("useQuery was not called by the hook");
  const { queryKey, queryFn } = captured;
  return {
    queryKey,
    result: await queryFn({ queryKey, meta: undefined } as unknown as Record<string, unknown>),
  };
}

describe("useOrdersList paging (N-06)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listExecute.mockResolvedValue({ data: [], total: 25, hasNext: true });
  });

  it("passes { page } through to the repository list call", async () => {
    const { result } = await runListQueryFn({ page: 2 });
    expect(listExecute).toHaveBeenCalled();
    const [filterArg] = listExecute.mock.calls[0] as unknown[];
    expect(filterArg).toMatchObject({ page: 2 });
    expect(result).toBeDefined();
  });

  it("does not send `offset` (the server rejects it)", async () => {
    await runListQueryFn({ page: 2 });
    const [filterArg] = listExecute.mock.calls[0] as unknown[];
    expect(filterArg).not.toHaveProperty("offset");
  });

  it("the queryKey contains the page so separate pages cache separately", async () => {
    const { queryKey } = await runListQueryFn({ page: 3 });
    expect(JSON.stringify(queryKey)).toContain("3");
  });
});
