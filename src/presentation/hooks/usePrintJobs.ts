import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import type { CreatePrintSendInput } from "@/application/ports/IPrintJobRepository";
import { refreshInventory } from "@/presentation/hooks/useInventory";

const ctx = buildTenantContext();

const KEYS = {
  all: ["print-jobs"] as const,
  open: ["print-jobs", "open"] as const,
};

export function usePrintJobs() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: ({ signal }) => {
      void signal;
      return container.printJobs.repository.listAll(ctx);
    },
    staleTime: 30_000,
  });
}

export function useOpenPrintJobs() {
  return useQuery({
    queryKey: KEYS.open,
    queryFn: ({ signal }) => {
      void signal;
      return container.printJobs.repository.listOpen(ctx);
    },
    staleTime: 30_000,
  });
}

export function useCreatePrintSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrintSendInput) => container.printJobs.send.execute(input, ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.open });
      // Send deducts source stock → inventory/dashboard refresh.
      void refreshInventory();
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useReceivePrint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof container.printJobs.receive.execute>[0]) =>
      container.printJobs.receive.execute(input, ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.open });
      // Receive creates a result roll, writes a printing expense + ledger row
      // and a cashbox cash-out → refresh inventory/financial caches.
      void refreshInventory();
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function nextPrintJobNumber(): string {
  return `PRT-${Date.now().toString(36).toUpperCase()}`;
}

export async function printJobById(id: string) {
  return container.printJobs.repository.findById(id, ctx);
}
