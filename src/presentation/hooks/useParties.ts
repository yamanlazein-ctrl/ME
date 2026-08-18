import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { PartyFilter } from "@/core/dtos/PartyDTO";
import type { Party, PartyKind } from "@/domain/entities/Party";
import type { CreatePartyInput } from "@/core/dtos/PartyDTO";
import type { Currency } from "@/domain/types";

const ctx = buildTenantContext();

const KEYS = {
  root: ["parties"] as const,
  list: (f?: PartyFilter) => ["parties", "list", f ?? {}] as const,
  detail: (id: string) => ["parties", "detail", id] as const,
};

/* ── Module-level reactive cache (single source of truth for the      */
/*    synchronous party API used by legacy components).                ── */

let _allParties: Party[] = [];

const _customers: Party[] = [];
const _suppliers: Party[] = [];

export const customers: Party[] = _customers;
export const suppliers: Party[] = _suppliers;

let version = 0;
const listeners = new Set<() => void>();

function notifyPartiesChange() {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion() {
  return version;
}

/* ── Loading ─────────────────────────────────────────────────────── */

let loadPromise: Promise<void> | null = null;
let loaded = false;

function isPaginated<T>(x: unknown): x is { data: T[] } {
  return Array.isArray((x as { data?: unknown })?.data);
}

async function loadAll(force = false): Promise<void> {
  if ((loaded && !force) || loadPromise)
    return loadPromise ?? Promise.resolve();
  loadPromise = (async () => {
    try {
      const [cRes, sRes] = await Promise.all([
        container.parties.list.execute(
          { kind: "customer", limit: 100, offset: 0 },
          ctx,
        ),
        container.parties.list.execute(
          { kind: "supplier", limit: 100, offset: 0 },
          ctx,
        ),
      ]);
      const cData = isPaginated<Party>(cRes) ? cRes.data : (cRes as Party[]);
      const sData = isPaginated<Party>(sRes) ? sRes.data : (sRes as Party[]);
      _allParties.splice(0, _allParties.length, ...cData, ...sData);
      _customers.splice(0, _customers.length, ...cData);
      _suppliers.splice(0, _suppliers.length, ...sData);
      loaded = true;
      notifyPartiesChange();
    } catch (e) {
      console.error("[useParties] load failed", e);
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function refreshParties(): Promise<void> {
  return loadAll(true);
}

if (typeof window !== "undefined" && getAccessToken()) {
  void loadAll();
}

/* ── Reactivity hook (re-renders on party changes) ───────────────── */

export function useParties() {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  return version;
}

/* ── React Query hooks ────────────────────────────────────────────── */

export function usePartiesList(filter: PartyFilter = {}) {
  useParties();
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: ({ signal }) => {
      void signal;
      return container.parties.list.execute(filter, ctx);
    },
    staleTime: 30_000,
  });
}

export function useParty(
  id: string,
  kind: "customer" | "supplier" = "customer",
) {
  return useQuery({
    queryKey: KEYS.detail(id),
    queryFn: ({ signal }) => {
      void signal;
      return container.parties.repository.findById(id, kind, ctx);
    },
    enabled: !!id,
  });
}

export function useCreateParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePartyInput) =>
      container.parties.create.execute(input, ctx),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.root }),
  });
}

export function useUpdateParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      id: string;
      kind: "customer" | "supplier";
      patch: Partial<Party>;
    }) =>
      container.parties.repository.update(
        params.id,
        params.kind,
        params.patch,
        ctx,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.root }),
  });
}

export function usePartyBalance(partyId: string, currency: string) {
  return useQuery({
    queryKey: ["party", "balance", partyId, currency],
    queryFn: ({ signal }) => {
      void signal;
      return container.parties.balance.execute(partyId, currency, ctx);
    },
    enabled: !!partyId,
    staleTime: 60_000,
  });
}

export const partiesQueryOptions = {
  list: (filter: PartyFilter = {}) => ({
    queryKey: KEYS.list(filter),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void signal;
      return container.parties.list.execute(filter, ctx);
    },
  }),
};

/* ── Synchronous lookup helpers (backed by the module cache) ──────── */

export function customerById(id: string): Party | undefined {
  return _allParties.find((p) => p.kind === "customer" && p.id === id);
}
export function supplierById(id: string): Party | undefined {
  return _allParties.find((p) => p.kind === "supplier" && p.id === id);
}

function syncPartiesCache() {
  _customers.splice(
    0,
    _customers.length,
    ..._allParties.filter((p) => p.kind === "customer"),
  );
  _suppliers.splice(
    0,
    _suppliers.length,
    ..._allParties.filter((p) => p.kind === "supplier"),
  );
  notifyPartiesChange();
}

/* ── Mutations (real API calls, optimistic local cache) ───────────── */

async function addParty(
  kind: PartyKind,
  input: { name: string; phone?: string; email?: string } & Record<
    string,
    unknown
  >,
): Promise<Party> {
  try {
    const res = await container.parties.create.execute(
      {
        kind,
        code: (input.code as string | undefined)?.trim() || undefined,
        name: input.name,
        phone: (input.phone as string) ?? undefined,
        email: (input.email as string) || undefined,
        companyName: (input.companyName as string) ?? undefined,
        commercialReg: (input.commercialReg as string) ?? undefined,
        category: (input.category as string) ?? undefined,
        salesRep: (input.salesRep as string) ?? undefined,
        mobile: (input.mobile as string) ?? undefined,
        whatsapp: (input.whatsapp as string) ?? undefined,
        altPhone: (input.altPhone as string) ?? undefined,
        address: (input.address as string) ?? undefined,
        city: (input.city as string) ?? undefined,
        country: (input.country as string) ?? undefined,
        taxNumber: (input.taxNumber as string) ?? undefined,
        openingBalance: (input.openingBalance as number) ?? undefined,
        creditLimit: input.creditLimit as number,
        currency: input.currency as Party["currency"],
        paymentTerms: input.paymentTerms as Party["paymentTerms"],
        paymentMethod: input.paymentMethod as Party["paymentMethod"],
        defaultDiscount: input.defaultDiscount as number,
        vat: input.vat as number,
        notes: (input.notes as string) ?? undefined,
      } as CreatePartyInput,
      ctx,
    );
    if (!res.ok) {
      throw new Error(res.error.message || "فشل الحفظ");
    }
    const party = res.value;
    _allParties.push(party);
    _customers.splice(
      0,
      _customers.length,
      ..._allParties.filter((p) => p.kind === "customer"),
    );
    _suppliers.splice(
      0,
      _suppliers.length,
      ..._allParties.filter((p) => p.kind === "supplier"),
    );
    syncPartiesCache();
    notifyPartiesChange();
    toast.success(
      kind === "customer"
        ? `تم حفظ العميل "${party.name}"`
        : `تم حفظ المورد "${party.name}"`,
    );
    return party;
  } catch (e) {
    toast.error(
      `فشل الحفظ: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
    throw e;
  }
}

export const addCustomer = (
  input: {
    name: string;
    phone?: string;
    email?: string;
  } & Record<string, unknown>,
): Promise<Party> => addParty("customer", input);

export const addSupplier = (
  input: {
    name: string;
    phone?: string;
    email?: string;
  } & Record<string, unknown>,
): Promise<Party> => addParty("supplier", input);

export async function updateCustomer(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const updated = await container.parties.repository.update(
      id,
      "customer",
      patch as Partial<Party>,
      ctx,
    );
    const idx = _allParties.findIndex((p) => p.id === id);
    if (idx >= 0) _allParties[idx] = updated;
    syncPartiesCache();
    notifyPartiesChange();
    toast.info("تم تحديث العميل");
  } catch (e) {
    toast.error(
      `فشل تحديث العميل: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
  }
}

export async function updateSupplier(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const updated = await container.parties.repository.update(
      id,
      "supplier",
      patch as Partial<Party>,
      ctx,
    );
    const idx = _allParties.findIndex((p) => p.id === id);
    if (idx >= 0) _allParties[idx] = updated;
    syncPartiesCache();
    notifyPartiesChange();
    toast.info("تم تحديث المورد");
  } catch (e) {
    toast.error(
      `فشل تحديث المورد: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
  }
}

export async function deleteCustomer(id: string): Promise<void> {
  try {
    await container.parties.repository.delete(id, "customer", ctx);
    _allParties = _allParties.filter((p) => p.id !== id);
    syncPartiesCache();
    notifyPartiesChange();
    toast.error("تم حذف العميل");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "فشل حذف العميل");
  }
}

export async function deleteSupplier(id: string): Promise<void> {
  try {
    await container.parties.repository.delete(id, "supplier", ctx);
    _allParties = _allParties.filter((p) => p.id !== id);
    syncPartiesCache();
    notifyPartiesChange();
    toast.error("تم حذف المورد");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "فشل حذف المورد");
  }
}

export function addPartyAttachment(
  partyId: string,
  attachment: { name: string; size: number },
): void {}
export function removePartyAttachment(partyId: string, attId: string): void {}

export type { Party, PartyKind, Currency };
