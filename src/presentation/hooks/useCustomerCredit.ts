import { useQuery } from "@tanstack/react-query";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";

/** GET /api/customers/:id/credit — mirrors backend `CustomerCreditPosition`. */
export type CustomerCreditPosition = {
  currency: string;
  /** Customer ledger balance (debit − credit). Negative = the customer is in credit. */
  ledgerBalance: number;
  openInvoicesRemaining: number;
  unattached: number;
  /** Advance payments / overpaid excess not yet attached to an invoice. */
  availableCredit: number;
};

export function useCustomerCredit(customerId: string, currency: string) {
  return useQuery({
    queryKey: ["customer-credit", customerId, currency],
    enabled: Boolean(customerId && currency),
    staleTime: 5_000,
    queryFn: async (): Promise<CustomerCreditPosition> => {
      const token = getAccessToken();
      const res = await fetch(
        `${getApiBaseUrl()}/api/customers/${encodeURIComponent(customerId)}/credit?currency=${encodeURIComponent(currency)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      const body = (await res.json().catch(() => ({}))) as CustomerCreditPosition & {
        message?: string;
      };
      if (!res.ok) throw new Error(body.message || `تعذّر جلب رصيد العميل (${res.status})`);
      return body;
    },
  });
}

/**
 * How a new sale is settled: cash first (capped at the total — the rest is
 * customer credit), then credit if the user opted in, the remainder is debt.
 * Pure, so the numbers shown on screen are exactly what is sent.
 */
export function planSaleSettlement(input: {
  total: number;
  cashPaid: number;
  availableCredit: number;
  useCredit: boolean;
}): { cashApplied: number; creditApplied: number; excessCash: number; debt: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const total = Math.max(0, r2(input.total));
  const cash = Math.max(0, r2(input.cashPaid));
  const cashApplied = Math.min(cash, total);
  const excessCash = r2(cash - cashApplied);
  const creditApplied = input.useCredit
    ? r2(Math.min(Math.max(0, input.availableCredit), total - cashApplied))
    : 0;
  const debt = r2(total - cashApplied - creditApplied);
  return { cashApplied: r2(cashApplied), creditApplied, excessCash, debt: Math.max(0, debt) };
}
