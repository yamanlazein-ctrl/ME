import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { isOk } from "@/core/result";
import { getAccessToken, SESSION_STARTED_EVENT } from "@/infrastructure/auth/TokenProvider";
import { PartyFilter } from "@/core/dtos/PartyDTO";
import type { Party, PartyKind } from "@/domain/entities/Party";
import type { CreatePartyInput } from "@/core/dtos/PartyDTO";
import type { Currency } from "@/domain/types";
import { invalidateFinancialViews } from "./invalidateFinancialViews";
import { fetchAllPaged } from "@/lib/fetchAllPaged";
import { getQueryClient } from "@/infrastructure/queryClient";
import type { PartyOpeningInput } from "@erp/shared";
import { ValidationError } from "@/core/errors";

function partyMutationErrorMessage(e: unknown): string {
  if (e instanceof ValidationError) {
    const firstKey = e.details ? Object.keys(e.details)[0] : undefined;
    const first = firstKey ? e.details?.[firstKey]?.[0] : undefined;
    if (first) {
      return e.message && !e.message.includes(first) ? `${e.message} — ${first}` : first;
    }
    return e.message || "بيانات غير صالحة";
  }
  if (e instanceof Error) return e.message;
  return "خطأ غير معروف";
}
const ctx = new Proxy({} as import("@/domain/types").TenantContext, {
  get: (_target, property: string) =>
    buildTenantContext()[property as keyof import("@/domain/types").TenantContext],
});

const KEYS = {
  root: ["parties"] as const,
  list: (f?: PartyFilter) => ["parties", "list", f ?? {}] as const,
  detail: (id: string) => ["parties", "detail", id] as const,
};

/* ── Module-level reactive cache (single source of truth for the      */
/*    synchronous party API used by legacy components).                ── */

let _allParties: Party[] = [];
// D-4: cancelled parties never appear in operational lists or pickers
// (`customers` / `suppliers`), but historical documents still resolve their
// names by id — so they are cached separately for the by-id lookups only.
const _cancelledParties: Party[] = [];

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
let retryAttempts = 0;

/**
 * D-3 / FR-068: a failed load must never look like "no customers". The list
 * screens read this state and show a clear error with Retry (or "loading")
 * instead of an empty table.
 */
export type PartiesLoadState =
  | { status: "idle" | "loading" | "ready" }
  | { status: "error"; message: string };
let loadState: PartiesLoadState = { status: "idle" };

function setLoadState(next: PartiesLoadState) {
  loadState = next;
  notifyPartiesChange();
}

export function getPartiesLoadState(): PartiesLoadState {
  return loadState;
}

function isPaginated<T>(x: unknown): x is { data: T[] } {
  return Array.isArray((x as { data?: unknown })?.data);
}

async function loadAll(force = false): Promise<void> {
  if ((loaded && !force) || loadPromise) return loadPromise ?? Promise.resolve();
  loadPromise = (async () => {
    if (!loaded) setLoadState({ status: "loading" });
    try {
      const ctx = buildTenantContext();
      // Legacy synchronous lookups (customerById/supplierById, prints, detail
      // pages) need every party, not just the first page. Walk the keyset
      // cursor (page numbers only as a fallback) until the server says done.
      const pageSize = 1000;
      const loadKind = (kind: "customer" | "supplier") =>
        fetchAllPaged<Party>(
          async (page, limit, cursor) => {
            const res = await container.parties.list.execute({ kind, limit, page, cursor }, ctx);
            return isPaginated<Party>(res) ? res : (res as Party[]);
          },
          { pageSize, label: `parties:${kind}` },
        );
      // History-only set: explicit status filter (the default list excludes cancelled).
      const loadCancelled = (kind: "customer" | "supplier") =>
        fetchAllPaged<Party>(
          async (page, limit, cursor) => {
            const res = await container.parties.list.execute(
              { kind, limit, page, cursor, status: "cancelled" } as Parameters<typeof container.parties.list.execute>[0],
              ctx,
            );
            return isPaginated<Party>(res) ? res : (res as Party[]);
          },
          { pageSize, label: `parties:${kind}:cancelled` },
        );
      const [cRes, sRes, ccRes, scRes] = await Promise.all([
        loadKind("customer"),
        loadKind("supplier"),
        loadCancelled("customer"),
        loadCancelled("supplier"),
      ]);
      const operational = (p: Party) => p.status !== "cancelled";
      const cData = (isPaginated<Party>(cRes) ? cRes.data : (cRes as Party[])).filter(operational);
      const sData = (isPaginated<Party>(sRes) ? sRes.data : (sRes as Party[])).filter(operational);
      const ccData = isPaginated<Party>(ccRes) ? ccRes.data : (ccRes as Party[]);
      const scData = isPaginated<Party>(scRes) ? scRes.data : (scRes as Party[]);
      _allParties.splice(0, _allParties.length, ...cData, ...sData);
      _cancelledParties.splice(0, _cancelledParties.length, ...ccData, ...scData);
      _customers.splice(0, _customers.length, ...cData);
      _suppliers.splice(0, _suppliers.length, ...sData);
      loaded = true;
      retryAttempts = 0;
      setLoadState({ status: "ready" });
    } catch (e) {
      console.error("[useParties] load failed", e);
      // D-3: surface the failure; the screen offers Retry (retryPartiesLoad).
      setLoadState({
        status: "error",
        message: e instanceof Error && e.message ? e.message : "تعذّر تحميل قائمة العملاء والموردين",
      });
      if (getAccessToken() && retryAttempts < 3) {
        retryAttempts += 1;
        setTimeout(() => void loadAll(true), 1_000);
      }
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function refreshParties(): Promise<void> {
  return loadAll(true);
}

/** D-3: user-initiated Retry after a failed load. */
export function retryPartiesLoad(): Promise<void> {
  retryAttempts = 0;
  return loadAll(true);
}

if (typeof window !== "undefined" && getAccessToken()) {
  void loadAll();
}
if (typeof window !== "undefined") {
  // A login after startup must fill the cache too (see persistTokens).
  window.addEventListener(SESSION_STARTED_EVENT, () => {
    retryAttempts = 0;
    void loadAll(true);
  });
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

export function useParty(id: string, kind: "customer" | "supplier" = "customer") {
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
    mutationFn: async (input: CreatePartyInput) => {
      const res = await container.parties.create.execute(input, ctx);
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      invalidateFinancialViews(qc, { refetchDashboard: true });
    },
    onError: (e: Error) => {
      toast.error(`فشل إنشاء الطرف: ${e.message}`);
    },
  });
}

export function useUpdateParty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; kind: "customer" | "supplier"; patch: Partial<Party> }) =>
      container.parties.repository.update(params.id, params.kind, params.patch, ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      invalidateFinancialViews(qc, { refetchDashboard: true });
    },
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

// By-id lookups also see cancelled parties, so historical documents keep
// showing their counterparty (D-4: preserved for audit/history).
export function customerById(id: string): Party | undefined {
  return (
    _allParties.find((p) => p.kind === "customer" && p.id === id) ??
    _cancelledParties.find((p) => p.kind === "customer" && p.id === id)
  );
}
export function supplierById(id: string): Party | undefined {
  return (
    _allParties.find((p) => p.kind === "supplier" && p.id === id) ??
    _cancelledParties.find((p) => p.kind === "supplier" && p.id === id)
  );
}

function syncPartiesCache() {
  // A party cancelled in this session leaves the operational lists at once.
  for (let i = _allParties.length - 1; i >= 0; i--) {
    const p = _allParties[i];
    if (p.status === "cancelled") {
      _allParties.splice(i, 1);
      if (!_cancelledParties.some((c) => c.id === p.id)) _cancelledParties.push(p);
    }
  }
  _customers.splice(0, _customers.length, ..._allParties.filter((p) => p.kind === "customer"));
  _suppliers.splice(0, _suppliers.length, ..._allParties.filter((p) => p.kind === "supplier"));
  notifyPartiesChange();
}

/* ── Mutations (real API calls, optimistic local cache) ───────────── */

async function addParty(
  kind: PartyKind,
  input: { name: string; phone?: string; email?: string } & Record<string, unknown>,
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
        openingDate: (input.openingDate as string) || undefined,
        openingNote: (input.openingNote as string) || undefined,
        openingCurrency: (input.openingCurrency as Party["currency"]) || undefined,
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
    _customers.splice(0, _customers.length, ..._allParties.filter((p) => p.kind === "customer"));
    _suppliers.splice(0, _suppliers.length, ..._allParties.filter((p) => p.kind === "supplier"));
    syncPartiesCache();
    notifyPartiesChange();
    toast.success(
      kind === "customer" ? `تم حفظ العميل "${party.name}"` : `تم حفظ المورد "${party.name}"`,
    );
    return party;
  } catch (e) {
    toast.error(`فشل الحفظ: ${partyMutationErrorMessage(e)}`);
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

/**
 * Field edit + (optional) opening-balance replacement. `patch.opening` — set by
 * PartyFormDialog only when the balance changed — goes to PUT …/:id/opening
 * after the field edit, with the version that edit returned.
 */
async function updateParty(
  kind: PartyKind,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { opening, ...fields } = patch as { opening?: PartyOpeningInput } & Record<string, unknown>;
  const repo = container.parties.repository;
  const label = kind === "customer" ? "العميل" : "المورد";
  try {
    let updated = await repo.update(id, kind, fields as Partial<Party>, ctx);
    if (opening) {
      updated = await repo.setOpening(id, kind, opening, updated.version, ctx);
      invalidateFinancialViews(getQueryClient(), { refetchDashboard: true });
    }
    const idx = _allParties.findIndex((p) => p.id === id);
    if (idx >= 0) _allParties[idx] = updated;
    syncPartiesCache();
    notifyPartiesChange();
    toast.info(`تم تحديث ${label}`);
  } catch (e) {
    toast.error(`فشل تحديث ${label}: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
    throw e;
  }
}

export const updateCustomer = (id: string, patch: Record<string, unknown>): Promise<void> =>
  updateParty("customer", id, patch);

export const updateSupplier = (id: string, patch: Record<string, unknown>): Promise<void> =>
  updateParty("supplier", id, patch);

export async function deleteCustomer(
  id: string,
  confirmCascade = false,
  expectedVersion?: number,
): Promise<void> {
  try {
    await container.parties.repository.delete(id, "customer", ctx, confirmCascade, expectedVersion);
    // Without cascade the backend only cancels the party (D-4): keep it for
    // by-id history lookups. A cascade purge removes it for good.
    const removed = _allParties.find((p) => p.id === id);
    if (removed && !confirmCascade && !_cancelledParties.some((c) => c.id === id)) {
      _cancelledParties.push(removed);
    }
    _allParties = _allParties.filter((p) => p.id !== id);
    syncPartiesCache();
    notifyPartiesChange();
    toast.success("تم حذف العميل");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "فشل حذف العميل");
    throw e;
  }
}

export async function deleteSupplier(
  id: string,
  confirmCascade = false,
  expectedVersion?: number,
): Promise<void> {
  try {
    await container.parties.repository.delete(id, "supplier", ctx, confirmCascade, expectedVersion);
    // Without cascade the backend only cancels the party (D-4): keep it for
    // by-id history lookups. A cascade purge removes it for good.
    const removed = _allParties.find((p) => p.id === id);
    if (removed && !confirmCascade && !_cancelledParties.some((c) => c.id === id)) {
      _cancelledParties.push(removed);
    }
    _allParties = _allParties.filter((p) => p.id !== id);
    syncPartiesCache();
    notifyPartiesChange();
    toast.success("تم حذف المورد");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "فشل حذف المورد");
    throw e;
  }
}

export function addPartyAttachment(
  partyId: string,
  attachment: { name: string; size: number },
): void {}
export function removePartyAttachment(partyId: string, attId: string): void {}

export type { Party, PartyKind, Currency };
