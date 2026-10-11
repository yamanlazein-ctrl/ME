/**
 * F-05 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the central helper
 * `invalidateFinancialViews` invalidates SEVEN financial query families, but
 * useInvoices/useExpenses/useReturns hand-rolled their own subsets — e.g. the
 * invoice create path skipped `statement`, so the party statement screen could
 * show stale balances after a new invoice. Every financial mutation must go
 * through the central helper.
 *
 * RED first: the invoice-create mutation path is extracted with its queryFn and
 * run against a stubbed repository; against the unmodified hook the captured
 * invalidation set is missing families.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

// Which query families were invalidated by the last captured invalidation call.
const invalidated: string[] = [];

function fakeQueryClient(): QueryClient {
  invalidated.length = 0;
  return {
    invalidateQueries: (o: { queryKey: readonly unknown[] }) => {
      invalidated.push(String(o.queryKey[0]));
    },
    refetchQueries: vi.fn(),
  } as unknown as QueryClient;
}

const invoiceCreateExecute = vi.fn();

vi.mock("@/infrastructure/container", () => ({
  container: {
    invoices: {
      create: { execute: (...a: unknown[]) => invoiceCreateExecute(...a) },
    },
    expenses: {
      create: { execute: vi.fn() },
      cancel: { execute: vi.fn() },
    },
    returns: {
      create: { execute: vi.fn() },
      cancel: { execute: vi.fn() },
    },
  },
}));
vi.mock("@/presentation/hooks/useInventory", () => ({
  rolls: [],
  refreshInventory: vi.fn(),
}));
// FE-02: the party list renders `p.stats` from useParties' module cache, which React Query cannot
// reach — the central helper must refresh it, or the list shows stale totals after every mutation.
const refreshParties = vi.fn(() => Promise.resolve());
vi.mock("@/presentation/hooks/useParties", () => ({ refreshParties: () => refreshParties() }));
vi.mock("@/infrastructure/di/auth-context", () => ({
  buildTenantContext: () => ({ tenantId: "t-1", userId: "u-1", userRole: "admin" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({ data: undefined, isLoading: true }),
    useQueryClient: () => activeQueryClient,
    // Capture every mutation's options: onSuccess carries the invalidation set.
    useMutation: (o: Record<string, unknown>) => {
      lastMutationOptions = o;
      return { mutate: vi.fn() } as never;
    },
  };
});

let lastMutationOptions: Record<string, unknown> | undefined;
/** The fake QueryClient the mocked useQueryClient returns. */
let activeQueryClient: QueryClient;

import { useCreateInvoice } from "./useInvoices";
import { invalidateFinancialViews } from "./invalidateFinancialViews";
import { useCreateReceiptVoucher, useCreatePaymentVoucher, useCancelVoucher } from "./useVouchers";
// Opening balance / day close write no ledger row — their cashbox+dashboard scope is correct.
import { useAddManualMovement, useDeleteManualMovement } from "./useCashbox";
import { useSettleParty, useSettleInvoices } from "./useStatement";

// "party" = usePartyBalance (["party","balance",…]); "parties" = the party list/detail family (useParties KEYS.root).
const REQUIRED_FAMILIES = [
  "dashboard",
  "cashbox",
  "ledger",
  "profit",
  "statement",
  "party",
  "parties",
  "invoices",
];

describe("financial mutations go through invalidateFinancialViews (F-05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceCreateExecute.mockResolvedValue({ ok: true });
  });

  it("invoice create invalidates ALL seven financial families (incl. statement)", () => {
    activeQueryClient = fakeQueryClient();
    useCreateInvoice();
    const opts = lastMutationOptions as { onSuccess: (r: unknown, v: unknown, c: unknown) => void };
    opts.onSuccess({ ok: true, value: { id: "inv-1" } }, undefined, activeQueryClient);
    for (const family of REQUIRED_FAMILIES) {
      expect(invalidated, `missing invalidation of [${family}] after invoice create`).toContain(
        family,
      );
    }
  });

  it("refreshes the party-list module cache (FE-02) — not only React Query families", () => {
    activeQueryClient = fakeQueryClient();
    invalidateFinancialViews(activeQueryClient);
    expect(refreshParties).toHaveBeenCalledTimes(1);
    expect(invalidated).toContain("parties");
  });

  // FE-05: every money-moving mutation — vouchers write ledger + cash, manual cashbox movements write a
  // ledger leg (SqliteCashboxRepository), settlement writes vouchers + ledger — must refresh the same
  // families. These used hand-rolled subsets that skipped ledger/profit/statement/party.
  const MONEY_MUTATIONS: Array<[string, () => void, unknown]> = [
    ["receipt voucher create", () => useCreateReceiptVoucher(), {}],
    ["payment voucher create", () => useCreatePaymentVoucher(), {}],
    ["voucher cancel", () => useCancelVoucher(), {}],
    ["manual cash movement add", () => useAddManualMovement(), {}],
    ["manual cash movement delete", () => useDeleteManualMovement(), {}],
    ["party settle", () => useSettleParty("p-1", "customer"), { ok: true, referenceNumber: "R-1" }],
    [
      "invoice settle",
      () => useSettleInvoices("p-1", "customer"),
      { ok: true, referenceNumber: "R-1" },
    ],
  ];
  for (const [name, hook, result] of MONEY_MUTATIONS) {
    it(`${name} refreshes every financial family + the party list cache`, () => {
      activeQueryClient = fakeQueryClient();
      hook();
      const opts = lastMutationOptions as {
        onSuccess: (r: unknown, v: unknown, c: unknown) => void;
      };
      opts.onSuccess(result, {}, undefined);
      for (const family of REQUIRED_FAMILIES) {
        expect(invalidated, `${name}: missing [${family}]`).toContain(family);
      }
      expect(refreshParties, `${name}: party list cache not refreshed`).toHaveBeenCalled();
    });
  }
});
