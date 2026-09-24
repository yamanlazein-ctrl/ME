import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { fetchAllPaged } from "@/lib/fetchAllPaged";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { isOk } from "@/core/result";
import { toast } from "sonner";
import type { VoucherFilter, CreateVoucherInput } from "@/core/dtos/VoucherDTO";
import type { VoucherKind, VoucherMethod } from "@/domain/types";

export type { VoucherKind, VoucherMethod };
export type Voucher = {
  id: string;
  kind: VoucherKind;
  number: string;
  date: string;
  amount: number;
  currency: string;
  status: string;
  partyId: string;
};

const ctx = new Proxy({} as import("@/domain/types").TenantContext, {
  get: (_target, property: string) =>
    buildTenantContext()[property as keyof import("@/domain/types").TenantContext],
});

const KEYS = {
  root: ["vouchers"] as const,
  list: (f?: VoucherFilter) => ["vouchers", "list", f ?? {}] as const,
  detail: (id: string) => ["vouchers", "detail", id] as const,
};

/**
 * `opts.all`: page through the API (page/limit, 1000 per page) and return
 * EVERY matching row — for screens that compute balances/totals and must not
 * work on a truncated first page.
 */
export function useVouchersList(filter?: VoucherFilter, opts?: { all?: boolean; enabled?: boolean }) {
  const all = Boolean(opts?.all);
  return useQuery({
    enabled: opts?.enabled ?? true,
    queryKey: all ? [...KEYS.list(filter), "all"] : KEYS.list(filter),
    queryFn: async ({ signal }) => {
      void signal;
      if (all) {
        // Receipts and payments are two endpoints with two independent
        // cursors, so an unfiltered walk pages each kind on its own.
        const kinds = filter?.kind ? [filter.kind] : (["receipt", "payment"] as const);
        const parts = await Promise.all(
          kinds.map((kind) =>
            fetchAllPaged(
              (page, limit, cursor) =>
                container.vouchers.repository.list(
                  { ...(filter ?? {}), kind, page, limit, cursor } as VoucherFilter,
                  ctx,
                ),
              { pageSize: 1000, maxPages: 500, label: `vouchers:${kind}` },
            ),
          ),
        );
        const data = parts.flat();
        return { data, total: data.length, hasNext: false };
      }
      return container.vouchers.repository.list(filter ?? {}, ctx);
    },
    staleTime: 30_000,
  });
}

export function useVoucher(id: string) {
  return useQuery({
    queryKey: KEYS.detail(id),
    queryFn: ({ signal }) => {
      void signal;
      return container.vouchers.repository.findById(id, ctx);
    },
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateReceiptVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVoucherInput) => {
      const res = await container.vouchers.createReceipt.execute(input, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: (_data, variables) => {
      toast.success("تم إنشاء سند القبض");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // A voucher writes a ledger row + moves cash → refresh those caches too.
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["profit"] });
      // A receipt linked to an invoice changes its paid/remaining.
      if (variables.invoiceId) {
        qc.invalidateQueries({ queryKey: ["invoices", "detail", variables.invoiceId] });
      }
    },
    onError: (e: Error) => {
      toast.error(`فشل إنشاء سند القبض: ${e.message}`);
    },
  });
}

export function useCreatePaymentVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVoucherInput) => {
      const res = await container.vouchers.createPayment.execute(input, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: (_data, variables) => {
      toast.success("تم إنشاء سند الصرف");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["profit"] });
      // A payment linked to an invoice changes its paid/remaining.
      if (variables.invoiceId) {
        qc.invalidateQueries({ queryKey: ["invoices", "detail", variables.invoiceId] });
      }
    },
    onError: (e: Error) => {
      toast.error(`فشل إنشاء سند الصرف: ${e.message}`);
    },
  });
}

export function useCancelVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await container.vouchers.cancel.execute(id, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: () => {
      toast.success("تم إلغاء السند");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["profit"] });
      // Cancelling a voucher may change an invoice's paid/remaining.
      qc.invalidateQueries({ queryKey: ["invoices", "detail"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل إلغاء السند: ${e.message}`);
    },
  });
}
