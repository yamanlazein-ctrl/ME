import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import { fetchAllPaged } from "@/lib/fetchAllPaged";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { InventoryFilter } from "@/application/ports";
import { Fabric, type FabricData } from "@/domain/entities/Fabric";
import { Color, type ColorData } from "@/domain/entities/Color";
import { Roll, type RollData } from "@/domain/entities/Roll";
import { UUID, type TenantContext } from "@/domain/types";
import { isOk } from "@/core/result";
import type { Currency } from "@/domain/types";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";
import { colorOnFabric, filterColorsByQuery } from "@/domain/inventory/colorLookup";
import { normalizeInventoryName } from "@/domain/inventory/normalizeInventoryName";
import { NotFoundError, ValidationError } from "@/core/errors";

export type FabricUnit = "meter" | "yard" | "kg";
export type RollStatus = "active" | "low" | "out";

const KEYS = {
  fabrics: () => ["inventory", "fabrics", buildTenantContext().tenantId] as const,
  rolls: () => ["inventory", "rolls", buildTenantContext().tenantId] as const,
};
const ctx = new Proxy({} as TenantContext, {
  get: (_target, property: string) => buildTenantContext()[property as keyof TenantContext],
});

/* ── Module-level reactive cache (single source of truth for the      */
/*    synchronous inventory API used by legacy components).            ── */

const fabricsCache: Fabric[] = [];
const colorsCache: Color[] = [];
const rollsCache: Roll[] = [];

export const fabrics: Fabric[] = fabricsCache;
export const colors: Color[] = colorsCache;
export const rolls: Roll[] = rollsCache;

let version = 0;
const listeners = new Set<() => void>();

function notifyInventoryChange() {
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
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;

function isPaginated<T>(x: unknown): x is { data: T[] } {
  return Array.isArray((x as { data?: unknown })?.data);
}

async function loadAll(force = false): Promise<void> {
  if (loaded && !force && !loadPromise) return Promise.resolve();
  if (loadPromise) {
    if (!force) return loadPromise;
    await loadPromise;
  }
  loadPromise = (async () => {
    try {
      const ctx = buildTenantContext();
      // Names/prints/pickers resolve fabrics, colors and rolls synchronously
      // from this cache, so it must hold every row — page by `page` until done.
      const opts = { pageSize: 1000, maxPages: 500 };
      const [fRes, cRes, rRes] = await Promise.all([
        fetchAllPaged<Fabric>(
          async (page, limit) =>
            (await container.inventory.listFabrics.execute({ limit, page }, ctx)) as never,
          { ...opts, label: "fabrics" },
        ),
        fetchAllPaged<Color>(
          async (page, limit) =>
            (await container.inventory.listColors.execute({ limit, page }, ctx)) as never,
          { ...opts, label: "colors" },
        ),
        fetchAllPaged<Roll>(
          async (page, limit) =>
            (await container.inventory.listRolls.execute({ limit, page }, ctx)) as never,
          { ...opts, label: "rolls" },
        ),
      ]);
      const fData = isPaginated<Fabric>(fRes) ? fRes.data : (fRes as Fabric[]);
      const cData = isPaginated<Color>(cRes) ? cRes.data : (cRes as Color[]);
      const rData = isPaginated<Roll>(rRes) ? rRes.data : (rRes as Roll[]);
      fabricsCache.splice(0, fabricsCache.length, ...fData);
      colorsCache.splice(0, colorsCache.length, ...cData);
      rollsCache.splice(0, rollsCache.length, ...rData);
      loaded = true;
      retryAttempts = 0;
      notifyInventoryChange();
    } catch (e) {
      console.error("[useInventory] load failed", e);
      if (getAccessToken() && retryAttempts < 3 && !retryTimer) {
        retryAttempts += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadAll(true);
        }, 1_000);
      }
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export function refreshInventory(): Promise<void> {
  return loadAll(true);
}

if (typeof window !== "undefined" && getAccessToken()) {
  void loadAll();
}

/* ── React Query hooks ────────────────────────────────────────────── */

export function useFabrics(filter: InventoryFilter = {}) {
  useInventory();
  return useQuery({
    queryKey: [...KEYS.fabrics(), filter],
    queryFn: ({ signal }) => {
      void signal;
      return container.inventory.listFabrics.execute(filter, buildTenantContext());
    },
    staleTime: 30_000,
  });
}

export function useRolls(filter: InventoryFilter = {}) {
  useInventory();
  return useQuery({
    queryKey: [...KEYS.rolls(), filter],
    queryFn: ({ signal }) => {
      void signal;
      return container.inventory.listRolls.execute(filter, buildTenantContext());
    },
    staleTime: 30_000,
  });
}

export function useCreateFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Omit<FabricData, "id" | "createdAt" | "tenantId" | "createdBy"> & {
        fabricId?: string;
      },
    ) => {
      const res = await container.inventory.createFabric.execute(
        {
          ...input,
          tenantId: ctx.tenantId,
          createdAt: new Date().toISOString(),
          createdBy: ctx.userName,
        } as FabricData,
        ctx,
      );
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.fabrics() }),
    onError: (e: Error) => {
      toast.error(`فشل إنشاء القماش: ${e.message}`);
    },
  });
}

export function useCreateRoll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Omit<RollData, "id" | "remainingKg" | "version" | "createdAt" | "tenantId"> & {
        remainingKg?: number;
      },
    ) => {
      const res = await container.inventory.createRoll.execute(
        {
          ...input,
          tenantId: ctx.tenantId,
          remainingKg: input.remainingKg ?? input.initialKg,
          version: 1,
          createdAt: new Date().toISOString(),
        } as RollData,
        ctx,
      );
      if (!isOk(res)) throw res.error;
      return res.value;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.rolls() }),
    onError: (e: Error) => {
      toast.error(`فشل إنشاء اللفافة: ${e.message}`);
    },
  });
}

/* ── Synchronous lookup helpers (backed by the module cache) ──────── */

export function fabricById(id: string): Fabric | null {
  return fabricsCache.find((f) => f.id === id) ?? null;
}

export function fabricByName(name: string): Fabric | undefined {
  const q = normalizeInventoryName(name);
  if (!q) return undefined;
  return fabricsCache.find((f) => normalizeInventoryName(f.name ?? "") === q);
}

export function searchFabrics(term: string, limit = 8): Fabric[] {
  const q = normalizeInventoryName(term);
  if (!q) return fabricsCache.slice(0, limit);
  return fabricsCache
    .filter((f) => normalizeInventoryName(f.name ?? "").includes(q))
    .slice(0, limit);
}

export function colorById(id: string): Color | null {
  return colorsCache.find((c) => c.id === id) ?? null;
}

export function rollById(id: string): Roll | null {
  return rollsCache.find((r) => r.id === id) ?? null;
}

export function colorsOfFabric(fabricId: string): Color[] {
  return colorsCache.filter((c) => c.fabricId === fabricId);
}

export function rollsOfColor(colorId: string): Roll[] {
  return rollsCache.filter((r) => r.colorId === colorId);
}

export function totalKgOfColor(colorId: string): number {
  return rollsOfColor(colorId).reduce((s, r) => s + r.remainingKg, 0);
}

export function totalPiecesOfColor(colorId: string): number {
  return rollsOfColor(colorId).reduce((s, r) => s + (r.remainingPieces ?? r.pieces ?? 1), 0);
}

export function totalKgOfFabric(fabricId: string): number {
  return colorsOfFabric(fabricId).reduce((s, c) => s + totalKgOfColor(c.id), 0);
}

export function totalPiecesOfFabric(fabricId: string): number {
  return colorsOfFabric(fabricId).reduce((s, c) => s + totalPiecesOfColor(c.id), 0);
}

export function searchColors(term: string, limit = 12, fabricId?: string): Color[] {
  return filterColorsByQuery(colorsCache, term, limit, fabricId);
}

export function colorByName(name: string, fabricId: string | undefined): Color | undefined {
  return colorOnFabric(colorsCache, fabricId, { name });
}

/**
 * Fix C-11 (forensic audit 2026-08-15, live-reproduced): this used to
 * search the entire tenant-wide colorsCache with no fabricId filter and
 * return the first arbitrary hit. `code` is only unique per
 * (tenantId, fabricId) at the DB level (colors.table.ts's unique index is
 * on tenantId+fabricId+name, and code isn't unique at all) — so a code
 * collision across two different fabrics silently merged a newly-received
 * roll into the wrong fabric's color. Live repro: creating "Silk / code
 * 101" while "Cotton / code 101" already existed filed the new roll under
 * Cotton's color record, discarding the typed name/hex entirely.
 *
 * fabricId is now required, not optional — every call site must know
 * which fabric it's resolving a code for. There is no safe "unscoped"
 * fallback: an unknown fabricId means the caller cannot yet tell whether
 * this is a real match, so it must be treated as "no match" (i.e. the
 * caller passes undefined/empty and gets undefined back), never as
 * "search everywhere and hope".
 */
export function colorByCode(code: string, fabricId: string | undefined): Color | undefined {
  const q = normalizeInventoryName(code);
  if (!q || !fabricId) return undefined;
  return colorsCache.find(
    (c) => c.fabricId === fabricId && normalizeInventoryName(c.code ?? "") === q,
  );
}

/* ── Reactivity hook (re-renders on inventory changes) ────────────── */

export function useInventory() {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  return version;
}

/* ── Mutations (real API calls, optimistic local cache) ───────────── */

export async function addFabric(
  input: Omit<FabricData, "id" | "createdAt" | "tenantId" | "createdBy">,
  opts?: { silent?: boolean },
): Promise<Fabric> {
  try {
    const fabric = await container.inventory.repository.createFabric(
      {
        ...input,
        tenantId: ctx.tenantId,
      },
      ctx,
    );
    fabricsCache.push(fabric);
    notifyInventoryChange();
    if (!opts?.silent) toast.success(`تم حفظ القماش "${fabric.name}"`);
    return fabric;
  } catch (e) {
    if (!opts?.silent)
      toast.error(`فشل حفظ القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
    throw e;
  }
}

export async function updateFabric(
  id: string,
  patch: Partial<Omit<FabricData, "id" | "createdAt" | "tenantId" | "createdBy">>,
) {
  try {
    const cached = fabricsCache.find((f) => f.id === id);
    const expectedVersion =
      typeof (patch as { version?: number }).version === "number"
        ? (patch as { version: number }).version
        : cached?.version;
    if (typeof expectedVersion !== "number") {
      throw new Error("الإصدار المتوقع (expectedVersion) مطلوب لتحديث القماش");
    }
    const updated = await container.inventory.repository.updateFabric(
      id,
      { ...patch, version: expectedVersion },
      ctx,
    );
    const idx = fabricsCache.findIndex((f) => f.id === id);
    if (idx >= 0) fabricsCache[idx] = updated;
    notifyInventoryChange();
    toast.info("تم تحديث القماش");
  } catch (e) {
    toast.error(`فشل تحديث القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

export async function deleteFabric(id: string) {
  try {
    const ok = await container.inventory.repository.deleteFabric(id, ctx);
    if (!ok) {
      // Repository returns false only for a confirmed 404 (fabric missing).
      toast.error("فشل حذف القماش: العنصر غير موجود");
      return;
    }
    const idx = fabricsCache.findIndex((f) => f.id === id);
    if (idx >= 0) fabricsCache.splice(idx, 1);
    const removedColorIds = new Set(colorsCache.filter((c) => c.fabricId === id).map((c) => c.id));
    if (removedColorIds.size > 0) {
      for (let i = colorsCache.length - 1; i >= 0; i--) {
        if (removedColorIds.has(colorsCache[i].id)) colorsCache.splice(i, 1);
      }
      for (let i = rollsCache.length - 1; i >= 0; i--) {
        if (removedColorIds.has(rollsCache[i].colorId)) rollsCache.splice(i, 1);
      }
    }
    notifyInventoryChange();
    toast.success("تم حذف القماش");
  } catch (e) {
    // Keep masters in cache on linked/validation failures — they are still live.
    if (e instanceof ValidationError) {
      toast.error(`فشل حذف القماش: ${e.message}`);
      return;
    }
    if (e instanceof NotFoundError) {
      toast.error("فشل حذف القماش: العنصر غير موجود");
      return;
    }
    toast.error(`فشل حذف القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

export async function addColor(
  input: Omit<ColorData, "id" | "createdAt" | "tenantId">,
  opts?: { silent?: boolean },
): Promise<Color> {
  try {
    const color = await container.inventory.repository.createColor(
      {
        ...input,
        tenantId: ctx.tenantId,
      },
      ctx,
    );
    colorsCache.push(color);
    notifyInventoryChange();
    if (!opts?.silent) toast.success(`تم حفظ اللون "${color.name}"`);
    return color;
  } catch (e) {
    if (!opts?.silent)
      toast.error(`فشل حفظ اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
    throw e;
  }
}

export async function updateColor(
  id: string,
  patch: Partial<Omit<ColorData, "id" | "createdAt" | "tenantId">>,
  opts?: { silent?: boolean },
) {
  try {
    const cached = colorsCache.find((c) => c.id === id);
    const expectedVersion =
      typeof (patch as { version?: number }).version === "number"
        ? (patch as { version: number }).version
        : cached?.version;
    if (typeof expectedVersion !== "number") {
      throw new Error("الإصدار المتوقع (expectedVersion) مطلوب لتحديث اللون");
    }
    const updated = await container.inventory.repository.updateColor(
      id,
      { ...patch, version: expectedVersion },
      ctx,
    );
    const idx = colorsCache.findIndex((c) => c.id === id);
    if (idx >= 0) colorsCache[idx] = updated;
    notifyInventoryChange();
    // silent: true → the caller aggregates feedback into its own toast
    // (invoice-save rename flow shows ONE success toast, not one per line).
    if (!opts?.silent) toast.info("تم تحديث اللون");
  } catch (e) {
    toast.error(`فشل تحديث اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

export async function deleteColor(id: string) {
  try {
    const ok = await container.inventory.repository.deleteColor(id, ctx);
    if (ok) {
      const idx = colorsCache.findIndex((c) => c.id === id);
      if (idx >= 0) colorsCache.splice(idx, 1);
      for (let i = rollsCache.length - 1; i >= 0; i--) {
        if (rollsCache[i].colorId === id) rollsCache.splice(i, 1);
      }
      notifyInventoryChange();
      toast.success("تم حذف اللون");
    } else {
      toast.error("فشل حذف اللون: العنصر غير موجود أو مرتبط بمعاملات موجودة");
    }
  } catch (e) {
    toast.error(`فشل حذف اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

export async function addRoll(
  input: Omit<RollData, "id" | "remainingKg" | "version" | "createdAt" | "tenantId"> & {
    remainingKg?: number;
  },
  opts?: { silent?: boolean },
): Promise<Roll> {
  try {
    const roll = await container.inventory.repository.createRoll(
      {
        ...input,
        tenantId: ctx.tenantId,
      },
      ctx,
    );
    rollsCache.push(roll);
    notifyInventoryChange();
    if (!opts?.silent) toast.success(`تم حفظ الصبغة "#${roll.rollNo}"`);
    return roll;
  } catch (e) {
    if (!opts?.silent)
      toast.error(`فشل حفظ الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
    throw e;
  }
}

export async function updateRoll(
  id: string,
  patch: Partial<Omit<RollData, "id" | "createdAt" | "tenantId">>,
) {
  try {
    const updated = await container.inventory.repository.updateRoll(id, patch, ctx);
    const idx = rollsCache.findIndex((r) => r.id === id);
    if (idx >= 0) rollsCache[idx] = updated;
    notifyInventoryChange();
    toast.info("تم تحديث الصبغة");
  } catch (e) {
    toast.error(`فشل تحديث الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

export async function deleteRoll(id: string) {
  try {
    const ok = await container.inventory.repository.deleteRoll(id, ctx);
    if (ok) {
      const idx = rollsCache.findIndex((r) => r.id === id);
      if (idx >= 0) rollsCache.splice(idx, 1);
      notifyInventoryChange();
      toast.success("تم حذف الصبغة");
    } else {
      toast.error("فشل حذف الصبغة: العنصر غير موجود أو مرتبط بمعاملات موجودة");
    }
  } catch (e) {
    toast.error(`فشل حذف الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`);
  }
}

/* ── Bulk delete (multi-select) ───────────────────────────────────── */

export async function deleteRolls(ids: string[]): Promise<number> {
  const removed = new Set<string>();
  for (const id of ids) {
    try {
      const ok = await container.inventory.repository.deleteRoll(id, ctx);
      if (ok) removed.add(id);
    } catch (e) {
      console.error(`[useInventory] deleteRoll failed for ${id}`, e);
    }
  }
  for (let i = rollsCache.length - 1; i >= 0; i--) {
    if (removed.has(rollsCache[i].id)) rollsCache.splice(i, 1);
  }
  const failed = ids.length - removed.size;
  if (removed.size > 0) {
    notifyInventoryChange();
    toast.error(`تم حذف ${removed.size} صبغة`);
  }
  if (failed > 0) {
    toast.error(`تعذر حذف ${failed} صبغة (مرتبطة بمعاملات موجودة)`);
  }
  return removed.size;
}

export async function deleteColors(ids: string[]): Promise<number> {
  const removed = new Set<string>();
  for (const id of ids) {
    try {
      const ok = await container.inventory.repository.deleteColor(id, ctx);
      if (ok) removed.add(id);
    } catch (e) {
      console.error(`[useInventory] deleteColor failed for ${id}`, e);
    }
  }
  // Remove the deleted colors and any rolls that belonged to them (cascade).
  for (let i = rollsCache.length - 1; i >= 0; i--) {
    if (removed.has(rollsCache[i].colorId)) rollsCache.splice(i, 1);
  }
  for (let i = colorsCache.length - 1; i >= 0; i--) {
    if (removed.has(colorsCache[i].id)) colorsCache.splice(i, 1);
  }
  const failed = ids.length - removed.size;
  if (removed.size > 0) {
    notifyInventoryChange();
    toast.error(`تم حذف ${removed.size} لون`);
  }
  if (failed > 0) {
    toast.error(`تعذر حذف ${failed} لون (مرتبط بمعاملات موجودة)`);
  }
  return removed.size;
}

export async function deleteFabrics(ids: string[]): Promise<number> {
  const removed = new Set<string>();
  for (const id of ids) {
    try {
      const ok = await container.inventory.repository.deleteFabric(id, ctx);
      if (ok) removed.add(id);
    } catch (e) {
      console.error(`[useInventory] deleteFabric failed for ${id}`, e);
    }
  }
  // Remove the deleted fabrics, their colors, and the rolls of those colors (cascade).
  const removedColorIds = new Set(
    colorsCache.filter((c) => removed.has(c.fabricId)).map((c) => c.id),
  );
  for (let i = rollsCache.length - 1; i >= 0; i--) {
    if (removedColorIds.has(rollsCache[i].colorId)) rollsCache.splice(i, 1);
  }
  for (let i = colorsCache.length - 1; i >= 0; i--) {
    if (removed.has(colorsCache[i].fabricId)) colorsCache.splice(i, 1);
  }
  for (let i = fabricsCache.length - 1; i >= 0; i--) {
    if (removed.has(fabricsCache[i].id)) fabricsCache.splice(i, 1);
  }
  const failed = ids.length - removed.size;
  if (removed.size > 0) {
    notifyInventoryChange();
    toast.error(`تم حذف ${removed.size} قماش`);
  }
  if (failed > 0) {
    toast.error(`تعذر حذف ${failed} قماش (مرتبط بمعاملات موجودة)`);
  }
  return removed.size;
}

/** Local-only stock adjustment (kept for legacy compatibility). */
export function decrementRoll(id: string, kg: number) {
  const idx = rollsCache.findIndex((r) => r.id === id);
  if (idx < 0) return;
  rollsCache[idx] = Roll.reconstitute({
    ...rollsCache[idx],
    remainingKg: Math.max(0, rollsCache[idx].remainingKg - kg),
  } as RollData);
  notifyInventoryChange();
}

export function rollStatus(r: Roll, minStockKg: number): RollStatus {
  if (r.remainingKg <= 0) return "out";
  if (r.remainingKg <= Math.max(minStockKg * 0.5, 10)) return "low";
  return "active";
}

/* ── helpers for route preloading (SSR-friendly) ───────────────────── */
export const inventoryQueryOptions = {
  fabrics: (filter: InventoryFilter = {}) => ({
    queryKey: [...KEYS.fabrics(), filter],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void signal;
      return container.inventory.listFabrics.execute(filter, ctx);
    },
  }),
  rolls: (filter: InventoryFilter = {}) => ({
    queryKey: [...KEYS.rolls(), filter],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void signal;
      return container.inventory.listRolls.execute(filter, ctx);
    },
  }),
};

export { Currency, Fabric, Color, Roll, type FabricData, type ColorData, type RollData };
export function formatSYP(amount: number): string {
  return formatMoney(amount) + " ل.س";
}
