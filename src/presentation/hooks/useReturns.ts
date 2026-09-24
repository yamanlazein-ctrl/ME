import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { fetchAllPaged } from "@/lib/fetchAllPaged";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { isOk } from "@/core/result";
import { toast } from "sonner";
import type { ReturnFilter, ReturnDTO } from "@/application/ports/IReturnRepository";
import { refreshInventory } from "./useInventory";

const ctx = new Proxy({} as import("@/domain/types").TenantContext, {
  get: (_target, property: string) =>
    buildTenantContext()[property as keyof import("@/domain/types").TenantContext],
});

const KEYS = {
  root: ["returns"] as const,
  list: (f?: ReturnFilter) => ["returns", "list", f ?? {}] as const,
};

/**
 * `opts.all`: page through the API (page/limit, 1000 per page) and return
 * EVERY matching row — for screens that compute balances/totals and must not
 * work on a truncated first page.
 */
export function useReturnsList(filter?: ReturnFilter, opts?: { all?: boolean }) {
  const all = Boolean(opts?.all);
  return useQuery({
    queryKey: all ? [...KEYS.list(filter), "all"] : KEYS.list(filter),
    queryFn: async ({ signal }) => {
      void signal;
      if (all) {
        const data = await fetchAllPaged(
          (page, limit) =>
            container.returns.list.execute({ ...(filter ?? {}), page, limit } as ReturnFilter, ctx),
          { pageSize: 1000, maxPages: 500, label: "returns" },
        );
        return { data, total: data.length, hasNext: false };
      }
      return container.returns.list.execute(filter ?? {}, ctx);
    },
    staleTime: 30_000,
  });
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Parameters<typeof container.returns.create.execute>[0]) => {
      const res = await container.returns.create.execute(input, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: () => {
      toast.success("تم إنشاء المرتجع");
      qc.invalidateQueries({ queryKey: KEYS.root });
      // Returns change inventory (entry return decreases stock, sale return increases)
      // and write a ledger entry — refresh related caches.
      void refreshInventory();
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(
        e instanceof Error &&
          e.message &&
          !/INSERT|UPDATE|SELECT|constraint|violates/i.test(e.message)
          ? `فشل إنشاء المرتجع: ${e.message}`
          : "حدث خطأ، يرجى المحاولة مرة أخرى أو التواصل مع الدعم",
      );
    },
  });
}

export function useCancelReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => container.returns.cancel.execute(id, ctx),
    onSuccess: () => {
      toast.error("تم إلغاء المرتجع");
      qc.invalidateQueries({ queryKey: KEYS.root });
      // Return cancel reverses the stock change and ledger entry.
      void refreshInventory();
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(
        e instanceof Error &&
          e.message &&
          !/INSERT|UPDATE|SELECT|constraint|violates/i.test(e.message)
          ? `فشل إلغاء المرتجع: ${e.message}`
          : "حدث خطأ، يرجى المحاولة مرة أخرى أو التواصل مع الدعم",
      );
    },
  });
}

export type ReturnKind = "entry" | "sale";
export type ReturnReason = "defect" | "wrong_quantity" | "wrong_order" | "other";
export const RETURN_REASONS: { code: ReturnReason; label: string }[] = [
  { code: "defect", label: "عيب في القماش" },
  { code: "wrong_quantity", label: "خطأ بالكمية" },
  { code: "wrong_order", label: "خطأ بالطلب" },
  { code: "other", label: "أخرى" },
];

export function returnAmount(r: { lines: { quantityKg: number; pricePerKg: number }[] }): number {
  return r.lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
}

export type { ReturnDTO };
