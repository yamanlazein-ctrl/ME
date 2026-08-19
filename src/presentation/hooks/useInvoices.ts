import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { isOk } from "@/core/result";
import { toast } from "sonner";
import type { InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { InvoiceData } from "@/domain/entities/Invoice";
import type { InvoiceType } from "@/domain/types";
import { refreshInventory } from "./useInventory";

/**
 * Presentation-layer hooks for invoice CRUD.
 *
 * Follows the same pattern as `useExpenses` — wraps the container's use cases
 * with React Query, providing caching, invalidation, and mutation helpers.
 */

const ctx = buildTenantContext();

const KEYS = {
  root: ["invoices"] as const,
  list: (f?: InvoiceFilter) => ["invoices", "list", f ?? {}] as const,
  detail: (id: string) => ["invoices", "detail", id] as const,
};

/* ── Queries ─────────────────────────────────────────────────────── */

/** List invoices with optional filters. */
export function useInvoicesList(filter?: InvoiceFilter) {
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: async ({ signal }) => {
      void signal;
      const res = await container.invoices.list.execute(filter ?? {}, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    staleTime: 30_000,
  });
}

/** Fetch a single invoice by ID. */
export function useInvoice(id: string) {
  return useQuery({
    queryKey: KEYS.detail(id),
    queryFn: ({ signal }) => {
      void signal;
      return container.invoices.repository.findById(id, ctx);
    },
    enabled: !!id,
    staleTime: 30_000,
  });
}

/* ── Mutations ───────────────────────────────────────────────────── */

/**
 * Create a new invoice.
 *
 * Input is the domain shape minus auto-generated fields. The hook injects
 * `tenantId` from the auth context.
 */
export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Omit<
        InvoiceData,
        "id" | "status" | "version" | "cancelledAt" | "createdAt" | "createdBy"
      >,
    ) => {
      try {
        const res = await container.invoices.create.execute(input, ctx);
        return isOk(res)
          ? { ok: true as const, value: res.value }
          : { ok: false as const, error: res.error };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "فشل إنشاء الفاتورة";
        return { ok: false as const, error: msg };
      }
    },
    onSuccess: (res) => {
      if (res.ok) {
        qc.invalidateQueries({ queryKey: KEYS.root });
        qc.invalidateQueries({ queryKey: KEYS.detail(res.value.id) });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        // Actively refetch the dashboard right now (even with no active observer)
        // so "فواتير اليوم" / "فواتير غير مسددة" / todaySales are already fresh
        // when the user returns to the dashboard — no reliance on refetchInterval.
        qc.refetchQueries({ queryKey: ["dashboard"] });
        // Invoice create changes stock (entry +, sale -) — refresh inventory caches.
        void refreshInventory();
        qc.invalidateQueries({ queryKey: ["inventory"] });
      } else {
        const rawErr = (res.error as any) ?? {};
        const details = rawErr.details as Record<string, string[]> | undefined;
        const firstDetail = details ? details[Object.keys(details)[0]]?.[0] : undefined;
        const errMsg = firstDetail
          ? `${rawErr.message} — ${firstDetail}`
          : (rawErr.message ?? "فشل إنشاء الفاتورة");
        toast.error(errMsg);
      }
    },
  });
}

/** Cancel an existing active invoice. */
export function useCancelInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        const res = await container.invoices.cancel.execute(id, ctx);
        return isOk(res)
          ? { ok: true as const, value: res.value }
          : { ok: false as const, error: res.error };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "فشل إلغاء الفاتورة";
        return { ok: false as const, error: msg };
      }
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.error("تم إلغاء الفاتورة");
        qc.invalidateQueries({ queryKey: KEYS.root });
        qc.invalidateQueries({ queryKey: KEYS.detail(res.value.id) });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.refetchQueries({ queryKey: ["dashboard"] });
        // Invoice cancel restores stock — refresh inventory caches.
        void refreshInventory();
        qc.invalidateQueries({ queryKey: ["inventory"] });
      } else {
        const errMsg =
          (res.error as any)?.message ?? (res.error as any)?.toString?.() ?? "فشل إلغاء الفاتورة";
        toast.error(errMsg);
      }
    },
  });
}

/**
 * Update an existing invoice's mutable fields (e.g. its line items — quantities,
 * pieces, and prices). Reuses the existing repository update path
 * (`PUT /api/invoices/:id`) — no new backend endpoint.
 */
export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Omit<InvoiceData, "id" | "tenantId" | "number" | "type">>;
    }) => {
      try {
        const updated = await container.invoices.repository.update(id, patch, ctx);
        return { ok: true as const, value: updated };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "فشل تحديث الفاتورة";
        return { ok: false as const, error: msg };
      }
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.success("تم حفظ التعديلات بنجاح");
        qc.invalidateQueries({ queryKey: KEYS.root });
        qc.invalidateQueries({ queryKey: KEYS.detail(res.value.id) });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
        qc.refetchQueries({ queryKey: ["dashboard"] });
        void refreshInventory();
        qc.invalidateQueries({ queryKey: ["inventory"] });
      } else {
        const rawErr = (res.error as any) ?? {};
        const details = rawErr.details as Record<string, string[]> | undefined;
        const firstDetail = details ? details[Object.keys(details)[0]]?.[0] : undefined;
        const errMsg = firstDetail
          ? `${rawErr.message} — ${firstDetail}`
          : (rawErr.message ?? "فشل تحديث الفاتورة");
        toast.error(errMsg);
      }
    },
  });
}

/* ── Utility: next invoice number ─────────────────────────────────── */

/* ── Utility: next invoice number ─────────────────────────────────── */

/**
 * Generate the next human-readable invoice number (e.g. "INV-2864").
 *
 * Reads synchronously from the in-memory store. In production this would be
 * a server-side call, but for the in-memory dev repository it's a direct
 * Map read.
 */
export function useInvoices() {
  return useQuery({
    queryKey: KEYS.root,
    queryFn: async ({ signal }) => {
      void signal;
      const res = await container.invoices.list.execute({}, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    staleTime: 30_000,
  });
}

/**
 * Sequential, traceable invoice number generator.
 * Produces: ENT-2026-0001, INV-2026-0001, RET-2026-0001
 * Each type has its own counter that increments per call within the session.
 * The 4-digit sequence number makes invoices easy to track and reference.
 */
const invoiceCounters: Record<string, number> = {};

export function nextInvoiceNumber(type: string): string {
  const prefix = type === "entry" ? "ENT" : type === "return" ? "RET" : "INV";
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  invoiceCounters[key] = (invoiceCounters[key] ?? 0) + 1;
  const seq = String(invoiceCounters[key]).padStart(4, "0");
  return `${key}-${seq}`;
}

export { type Invoice } from "@/domain/entities/Invoice";
export { invoiceTotal, invoiceRemaining } from "@/core/calculations/invoiceCalc";
