import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { toast } from "sonner";
import type {
  CreateManualMovementInput,
  CloseDayInput,
} from "@/application/ports/ICashboxRepository";
export type { ManualMovementType } from "@/application/ports/ICashboxRepository";

const ctx = buildTenantContext();

const KEYS = {
  state: ["cashbox", "state"] as const,
  movements: ["cashbox", "movements"] as const,
  closings: ["cashbox", "closings"] as const,
};

export const MANUAL_TYPE_LABEL: Record<string, string> = {
  capital: "رأس المال",
  withdrawal: "سحب",
  transfer: "تحويل",
  adjustment: "تسوية",
  correction: "تصحيح",
};

export function useCashboxState() {
  return useQuery({
    queryKey: KEYS.state,
    queryFn: ({ signal }) => container.cashbox.state.getState(ctx),
    staleTime: 15_000,
  });
}

export function useCashBalance(date?: string, currency?: string) {
  return useQuery({
    queryKey: [...KEYS.state, "balance", date ?? "today", currency ?? "SYP"],
    queryFn: ({ signal }) => {
      void signal;
      if (date)
        return container.cashbox.state.cashBalanceOn(date, ctx, currency);
      return container.cashbox.state.currentBalance(ctx);
    },
    staleTime: 15_000,
  });
}

export function useManualMovements() {
  return useQuery({
    queryKey: KEYS.movements,
    queryFn: ({ signal }) => {
      void signal;
      return container.cashbox.movements.listManual(ctx);
    },
    staleTime: 15_000,
  });
}

export function useAddManualMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateManualMovementInput) =>
      container.cashbox.addMovement.execute(input, ctx),
    onSuccess: () => {
      toast.success("تمت إضافة الحركة اليدوية");
      qc.invalidateQueries({ queryKey: KEYS.state });
      qc.invalidateQueries({ queryKey: KEYS.movements });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل إضافة الحركة اليدوية: ${e.message}`);
    },
  });
}

export function useDeleteManualMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      container.cashbox.state.deleteManualMovement(id, ctx),
    onSuccess: () => {
      toast.error("تم حذف الحركة اليدوية");
      qc.invalidateQueries({ queryKey: KEYS.state });
      qc.invalidateQueries({ queryKey: KEYS.movements });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل حذف الحركة اليدوية: ${e.message}`);
    },
  });
}

export interface SetOpeningBalanceInput {
  balance: number;
  date: string;
  currency: string;
}

export function useSetOpeningBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetOpeningBalanceInput) =>
      container.cashbox.state.setOpeningBalance(
        input.balance,
        input.date,
        input.currency as import("@/domain/types").Currency,
        ctx,
      ),
    onSuccess: () => {
      toast.success("تم تعيين الرصيد الافتتاحي");
      qc.invalidateQueries({ queryKey: KEYS.state });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل تعيين الرصيد الافتتاحي: ${e.message}`);
    },
  });
}

export function useCloseDay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CloseDayInput) =>
      container.cashbox.closeDay.execute(input, ctx),
    onSuccess: () => {
      toast.info("تم إقفال اليوم");
      qc.invalidateQueries({ queryKey: KEYS.state });
      qc.invalidateQueries({ queryKey: KEYS.closings });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل إقفال اليوم: ${e.message}`);
    },
  });
}

export function useDayLock(date: string) {
  return useQuery({
    queryKey: [...KEYS.state, "lock", date],
    queryFn: ({ signal }) => {
      void signal;
      return container.cashbox.state.isDayLocked(date, ctx);
    },
  });
}

export function useLastClosing() {
  return useQuery({
    queryKey: KEYS.closings,
    queryFn: ({ signal }) => {
      void signal;
      return container.cashbox.state.lastClosing(ctx);
    },
    staleTime: 30_000,
  });
}
