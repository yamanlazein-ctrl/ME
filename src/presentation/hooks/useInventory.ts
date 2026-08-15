import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { InventoryFilter } from "@/application/ports";
import { Fabric, type FabricData } from "@/domain/entities/Fabric";
import { Color, type ColorData } from "@/domain/entities/Color";
import { Roll, type RollData } from "@/domain/entities/Roll";
import { UUID, type TenantContext } from "@/domain/types";
import type { Currency } from "@/domain/types";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


export type FabricUnit = "meter" | "yard" | "kg";
export type RollStatus = "active" | "low" | "out";

const ctx = buildTenantContext();

const KEYS = {
  fabrics: ["inventory", "fabrics", ctx.tenantId] as const,
  rolls: ["inventory", "rolls", ctx.tenantId] as const,
};

/* ── Module-level reactive cache (single source of truth for the      */
/*    synchronous inventory API used by legacy components).            ── */

let fabricsCache: Fabric[] = [];
let colorsCache: Color[] = [];
let rollsCache: Roll[] = [];

export let fabrics: Fabric[] = fabricsCache;
export let colors: Color[] = colorsCache;
export let rolls: Roll[] = rollsCache;

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

function isPaginated<T>(x: unknown): x is { data: T[] } {
  return Array.isArray((x as { data?: unknown })?.data);
}

async function loadAll(force = false): Promise<void> {
  if ((loaded && !force) || loadPromise)
    return loadPromise ?? Promise.resolve();
  loadPromise = (async () => {
    try {
      const [fRes, cRes, rRes] = await Promise.all([
        container.inventory.listFabrics.execute({ limit: 1000 }, ctx),
        container.inventory.listColors.execute({ limit: 1000 }, ctx),
        container.inventory.listRolls.execute({ limit: 1000 }, ctx),
      ]);
      const fData = isPaginated<Fabric>(fRes) ? fRes.data : (fRes as Fabric[]);
      const cData = isPaginated<Color>(cRes) ? cRes.data : (cRes as Color[]);
      const rData = isPaginated<Roll>(rRes) ? rRes.data : (rRes as Roll[]);
      fabricsCache.splice(0, fabricsCache.length, ...fData);
      colorsCache.splice(0, colorsCache.length, ...cData);
      rollsCache.splice(0, rollsCache.length, ...rData);
      loaded = true;
      notifyInventoryChange();
    } catch (e) {
      console.error("[useInventory] load failed", e);
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
    queryKey: [...KEYS.fabrics, filter],
    queryFn: ({ signal }) => {
      void signal;
      return container.inventory.listFabrics.execute(filter, ctx);
    },
    staleTime: 30_000,
  });
}

export function useRolls(filter: InventoryFilter = {}) {
  useInventory();
  return useQuery({
    queryKey: [...KEYS.rolls, filter],
    queryFn: ({ signal }) => {
      void signal;
      return container.inventory.listRolls.execute(filter, ctx);
    },
    staleTime: 30_000,
  });
}

export function useCreateFabric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: Omit<FabricData, "id" | "createdAt" | "tenantId" | "createdBy"> & {
        fabricId?: string;
      },
    ) => {
      return container.inventory.createFabric.execute(
        {
          ...input,
          tenantId: ctx.tenantId,
          createdAt: new Date().toISOString(),
          createdBy: ctx.userName,
        } as FabricData,
        ctx,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.fabrics }),
  });
}

export function useCreateRoll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: Omit<
        RollData,
        "id" | "remainingKg" | "version" | "createdAt" | "tenantId"
      > & {
        remainingKg?: number;
      },
    ) =>
      container.inventory.createRoll.execute(
        {
          ...input,
          tenantId: ctx.tenantId,
          remainingKg: input.remainingKg ?? input.initialKg,
          version: 1,
          createdAt: new Date().toISOString(),
        } as RollData,
        ctx,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.rolls }),
  });
}

/* ── Synchronous lookup helpers (backed by the module cache) ──────── */

export function fabricById(id: string): Fabric | null {
  return fabricsCache.find((f) => f.id === id) ?? null;
}

export function fabricByName(name: string): Fabric | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  return fabricsCache.find((f) => (f.name ?? "").trim().toLowerCase() === q);
}

export function searchFabrics(term: string, limit = 8): Fabric[] {
  const q = term.trim().toLowerCase();
  if (!q) return fabricsCache.slice(0, limit);
  return fabricsCache
    .filter((f) => (f.name ?? "").toLowerCase().includes(q))
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

export function totalKgOfFabric(fabricId: string): number {
  return colorsOfFabric(fabricId).reduce((s, c) => s + totalKgOfColor(c.id), 0);
}

export function searchColors(term: string, limit = 8): Color[] {
  const all = colorsCache;
  const q = term.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const scored = all
    .map((c) => {
      const code = (c.code ?? "").toLowerCase();
      const name = (c.name ?? "").toLowerCase();
      if (code === q) return { c, score: 0 };
      if (name === q) return { c, score: 1 };
      if (code.startsWith(q)) return { c, score: 2 };
      if (name.startsWith(q)) return { c, score: 3 };
      if (code.includes(q) || name.includes(q)) return { c, score: 4 };
      return null;
    })
    .filter((x): x is { c: Color; score: number } => x !== null)
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.c);
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
  const q = code.trim().toLowerCase();
  if (!q || !fabricId) return undefined;
  return colorsCache.find(
    (c) => c.fabricId === fabricId && (c.code ?? "").trim().toLowerCase() === q,
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
      toast.error(
        `فشل حفظ القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
      );
    throw e;
  }
}

export async function updateFabric(
  id: string,
  patch: Partial<
    Omit<FabricData, "id" | "createdAt" | "tenantId" | "createdBy">
  >,
) {
  try {
    const updated = await container.inventory.repository.updateFabric(
      id,
      patch,
      ctx,
    );
    const idx = fabricsCache.findIndex((f) => f.id === id);
    if (idx >= 0) fabricsCache[idx] = updated;
    notifyInventoryChange();
    toast.info("تم تحديث القماش");
  } catch (e) {
    toast.error(
      `فشل تحديث القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
  }
}

export async function deleteFabric(id: string) {
  try {
    const ok = await container.inventory.repository.deleteFabric(id, ctx);
    if (ok) {
      const idx = fabricsCache.findIndex((f) => f.id === id);
      if (idx >= 0) fabricsCache.splice(idx, 1);
      notifyInventoryChange();
      toast.error("تم حذف القماش");
    } else {
      // The backend rejected the delete (e.g. the fabric or its colors/rolls
      // are referenced by invoices, returns, print jobs, …). Do NOT remove it
      // from the cache — otherwise it vanishes visually but reappears on reload.
      toast.error("فشل حذف القماش: العنصر غير موجود أو مرتبط بمعاملات موجودة");
    }
  } catch (e) {
    toast.error(
      `فشل حذف القماش: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
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
      toast.error(
        `فشل حفظ اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
      );
    throw e;
  }
}

export async function updateColor(
  id: string,
  patch: Partial<Omit<ColorData, "id" | "createdAt" | "tenantId">>,
) {
  try {
    const updated = await container.inventory.repository.updateColor(
      id,
      patch,
      ctx,
    );
    const idx = colorsCache.findIndex((c) => c.id === id);
    if (idx >= 0) colorsCache[idx] = updated;
    notifyInventoryChange();
    toast.info("تم تحديث اللون");
  } catch (e) {
    toast.error(
      `فشل تحديث اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
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
      toast.error("تم حذف اللون");
    } else {
      toast.error("فشل حذف اللون: العنصر غير موجود أو مرتبط بمعاملات موجودة");
    }
  } catch (e) {
    toast.error(
      `فشل حذف اللون: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
  }
}

export async function addRoll(
  input: Omit<
    RollData,
    "id" | "remainingKg" | "version" | "createdAt" | "tenantId"
  > & {
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
      toast.error(
        `فشل حفظ الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
      );
    throw e;
  }
}

export async function updateRoll(
  id: string,
  patch: Partial<Omit<RollData, "id" | "createdAt" | "tenantId">>,
) {
  try {
    const updated = await container.inventory.repository.updateRoll(
      id,
      patch,
      ctx,
    );
    const idx = rollsCache.findIndex((r) => r.id === id);
    if (idx >= 0) rollsCache[idx] = updated;
    notifyInventoryChange();
    toast.info("تم تحديث الصبغة");
  } catch (e) {
    toast.error(
      `فشل تحديث الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
  }
}

export async function deleteRoll(id: string) {
  try {
    const ok = await container.inventory.repository.deleteRoll(id, ctx);
    if (ok) {
      const idx = rollsCache.findIndex((r) => r.id === id);
      if (idx >= 0) rollsCache.splice(idx, 1);
      notifyInventoryChange();
      toast.error("تم حذف الصبغة");
    } else {
      toast.error("فشل حذف الصبغة: العنصر غير موجود أو مرتبط بمعاملات موجودة");
    }
  } catch (e) {
    toast.error(
      `فشل حذف الصبغة: ${e instanceof Error ? e.message : "خطأ غير معروف"}`,
    );
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
    queryKey: [...KEYS.fabrics, filter],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void signal;
      return container.inventory.listFabrics.execute(filter, ctx);
    },
  }),
  rolls: (filter: InventoryFilter = {}) => ({
    queryKey: [...KEYS.rolls, filter],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void signal;
      return container.inventory.listRolls.execute(filter, ctx);
    },
  }),
};

export {
  Currency,
  Fabric,
  Color,
  Roll,
  type FabricData,
  type ColorData,
  type RollData,
};
export function formatSYP(amount: number): string {
  return formatMoney(amount) + " ل.س";
}
