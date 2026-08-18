import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
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

const ctx = buildTenantContext();

const KEYS = {
  root: ["vouchers"] as const,
  list: (f?: VoucherFilter) => ["vouchers", "list", f ?? {}] as const,
  detail: (id: string) => ["vouchers", "detail", id] as const,
};

export function useVouchersList(filter?: VoucherFilter) {
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: ({ signal }) => {
      void signal;
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
    mutationFn: (input: CreateVoucherInput) => container.vouchers.createReceipt.execute(input, ctx),
    onSuccess: (_data, variables) => {
      toast.success("تم إنشاء سند القبض");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // A voucher writes a ledger row + moves cash → refresh those caches too.
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
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
    mutationFn: (input: CreateVoucherInput) => container.vouchers.createPayment.execute(input, ctx),
    onSuccess: (_data, variables) => {
      toast.success("تم إنشاء سند الصرف");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
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
    mutationFn: (id: string) => container.vouchers.cancel.execute(id, ctx),
    onSuccess: () => {
      toast.error("تم إلغاء السند");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["statement"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      // Cancelling a voucher may change an invoice's paid/remaining.
      qc.invalidateQueries({ queryKey: ["invoices", "detail"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل إلغاء السند: ${e.message}`);
    },
  });
}
