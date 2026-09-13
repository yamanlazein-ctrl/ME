import { and, eq } from "drizzle-orm";
import { pool } from "../../../infrastructure/orm/drizzle.js";
import type { DB } from "../../../infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { parties } from "../../../infrastructure/orm/schemas/party.table.js";
import { fabrics } from "../../../infrastructure/orm/schemas/fabric.table.js";
import { colors } from "../../../infrastructure/orm/schemas/color.table.js";
import { rolls } from "../../../infrastructure/orm/schemas/roll.table.js";
import type { IPartyRepository } from "../../ports/IPartyRepository.js";
import type { IFabricRepository } from "../../ports/IFabricRepository.js";
import type { IColorRepository } from "../../ports/IColorRepository.js";
import type { IRollRepository } from "../../ports/IRollRepository.js";
import type { CreateInvoiceInput } from "../../../domain/entities/Invoice.js";
import type { CreateReturnInput } from "../../../domain/entities/Return.js";
import type { PartyData } from "../../../domain/entities/Party.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { logger } from "../../../infrastructure/config/logger.js";

export type SyncPartySnapshot = {
  id: string;
  kind: string;
  code?: string | null;
  name: string;
  companyName?: string | null;
  commercialReg?: string | null;
  category?: string | null;
  salesRep?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  currency: string;
  paymentTerms?: string | null;
  paymentMethod?: string | null;
  defaultDiscount?: number;
  vat?: number;
  status: string;
  notes?: string | null;
};

export type SyncFabricSnapshot = {
  id: string;
  name: string;
  category?: string | null;
  minStockKg?: number;
  unit?: string | null;
  notes?: string | null;
  imageUrl?: string | null;
};

export type SyncColorSnapshot = {
  id: string;
  fabricId: string;
  name: string;
  code?: string | null;
  hex?: string | null;
  imageUrl?: string | null;
};

export type SyncRollSnapshot = {
  id: string;
  colorId: string;
  rollNo: string;
  dyeBatch?: string | null;
  initialKg: number;
  /** Remaining BEFORE the invoice effect (so hub replay can apply stock correctly). */
  remainingKg: number;
  pieces: number;
  remainingPieces: number;
  pricePerKg: number;
  salePricePerKg?: number | null;
  currency: string;
  supplierId?: string | null;
  entryDate: string;
  widthCm?: number | null;
  weightGsm?: number | null;
  status: string;
};

export type InvoiceSyncDependencies = {
  parties: SyncPartySnapshot[];
  fabrics: SyncFabricSnapshot[];
  colors: SyncColorSnapshot[];
  rolls: SyncRollSnapshot[];
};

/**
 * Single canonical mapping from a party row to its sync snapshot.
 *
 * Three capture paths used to carry their own inline copy of this 25-field
 * mapping (invoice, voucher route, order route). Any field added in one place
 * and missed in another would replay a silently incomplete party on the hub —
 * the exact drift this helper eliminates. All capture functions below must go
 * through it; a static invariant pins that.
 */
export function toPartySnapshot(p: PartyData): SyncPartySnapshot {
  return {
    id: p.id,
    kind: p.kind,
    code: p.code ?? null,
    name: p.name,
    companyName: p.companyName ?? null,
    commercialReg: p.commercialReg ?? null,
    category: p.category ?? null,
    salesRep: p.salesRep ?? null,
    phone: p.phone ?? null,
    mobile: p.mobile ?? null,
    whatsapp: p.whatsapp ?? null,
    altPhone: p.altPhone ?? null,
    email: p.email ?? null,
    website: p.website ?? null,
    address: p.address ?? null,
    city: p.city ?? null,
    country: p.country ?? null,
    taxNumber: p.taxNumber ?? null,
    currency: p.currency,
    paymentTerms: p.paymentTerms ?? null,
    paymentMethod: p.paymentMethod ?? null,
    defaultDiscount: p.defaultDiscount,
    vat: p.vat,
    status: p.status,
    notes: p.notes ?? null,
  };
}

/**
 * Capture party-only dependencies for documents that reference parties but no
 * stock (vouchers, orders). Missing parties resolve to an empty list — the hub
 * then fails the replay as retryable `failed` (converging when the party
 * arrives) rather than dead-lettering a valid money unit.
 */
export async function capturePartySyncDependencies(
  partyRepo: IPartyRepository,
  partyIds: Array<string | undefined | null>,
  ctx: TenantContext,
): Promise<InvoiceSyncDependencies> {
  const parties: SyncPartySnapshot[] = [];
  const seen = new Set<string>();
  for (const id of partyIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = await partyRepo.findById(id, ctx);
    if (!p) continue;
    parties.push(toPartySnapshot(p));
  }
  return { parties, fabrics: [], colors: [], rolls: [] };
}

/**
 * Capture master-data snapshots needed to replay an invoice on another node.
 * Roll remaining qty is adjusted back to the pre-invoice state.
 */
export async function captureInvoiceSyncDependencies(
  repos: {
    partyRepo: IPartyRepository;
    fabricRepo: IFabricRepository;
    colorRepo: IColorRepository;
    rollRepo: IRollRepository;
  },
  createInput: CreateInvoiceInput,
  ctx: TenantContext,
): Promise<InvoiceSyncDependencies> {
  const partyIds = new Set<string>([createInput.partyId]);
  const rollIds = new Set(createInput.lines.map((l: { rollId: string }) => l.rollId));
  const fabricIds = new Set(createInput.lines.map((l: { fabricId: string }) => l.fabricId));
  const colorIds = new Set(createInput.lines.map((l: { colorId: string }) => l.colorId));

  const kgDeltaByRoll = new Map<string, number>();
  const piecesDeltaByRoll = new Map<string, number>();
  for (const line of createInput.lines) {
    kgDeltaByRoll.set(line.rollId, (kgDeltaByRoll.get(line.rollId) ?? 0) + Number(line.quantityKg));
    piecesDeltaByRoll.set(
      line.rollId,
      (piecesDeltaByRoll.get(line.rollId) ?? 0) + Number(line.pieces ?? 1),
    );
  }

  const partySnaps: SyncPartySnapshot[] = [];
  for (const id of partyIds) {
    const p = await repos.partyRepo.findById(id, ctx);
    if (!p) continue;
    partySnaps.push(toPartySnapshot(p));
  }

  const fabricSnaps: SyncFabricSnapshot[] = [];
  for (const id of fabricIds) {
    const f = await repos.fabricRepo.findById(id, ctx);
    if (!f) continue;
    fabricSnaps.push({
      id: f.id,
      name: f.name,
      category: f.category ?? null,
      minStockKg: f.minStockKg,
      unit: f.unit ?? null,
      notes: f.notes ?? null,
      imageUrl: f.imageUrl ?? null,
    });
  }

  const colorSnaps: SyncColorSnapshot[] = [];
  for (const id of colorIds) {
    const c = await repos.colorRepo.findById(id, ctx);
    if (!c) continue;
    colorSnaps.push({
      id: c.id,
      fabricId: c.fabricId,
      name: c.name,
      code: c.code ?? null,
      hex: c.hex ?? null,
      imageUrl: c.imageUrl ?? null,
    });
  }

  const rollSnaps: SyncRollSnapshot[] = [];
  for (const id of rollIds) {
    const r = await repos.rollRepo.findById(id, ctx);
    if (!r) continue;
    if (r.supplierId) partyIds.add(r.supplierId);

    const kgDelta = kgDeltaByRoll.get(id) ?? 0;
    const piecesDelta = piecesDeltaByRoll.get(id) ?? 0;
    // After local invoice apply: sale decreased remaining; entry increased it.
    // Reconstruct pre-invoice remaining so hub replay can apply the same delta.
    let remainingKg = Number(r.remainingKg);
    let remainingPieces = Number(r.remainingPieces);
    if (createInput.type === "sale") {
      remainingKg += kgDelta;
      remainingPieces += piecesDelta;
    } else {
      remainingKg = Math.max(0, remainingKg - kgDelta);
      remainingPieces = Math.max(0, remainingPieces - piecesDelta);
    }

    rollSnaps.push({
      id: r.id,
      colorId: r.colorId,
      rollNo: r.rollNo,
      dyeBatch: r.dyeBatch ?? null,
      initialKg: Number(r.initialKg),
      remainingKg,
      pieces: r.pieces,
      remainingPieces,
      pricePerKg: Number(r.pricePerKg),
      salePricePerKg: r.salePricePerKg != null ? Number(r.salePricePerKg) : null,
      currency: r.currency,
      supplierId: r.supplierId ?? null,
      entryDate: r.entryDate,
      widthCm: r.widthCm != null ? Number(r.widthCm) : null,
      weightGsm: r.weightGsm != null ? Number(r.weightGsm) : null,
      status: r.status,
    });
  }

  // Supplier parties referenced by rolls (after roll scan).
  for (const id of partyIds) {
    if (partySnaps.some((p) => p.id === id)) continue;
    const p = await repos.partyRepo.findById(id, ctx);
    if (!p) continue;
    partySnaps.push(toPartySnapshot(p));
  }

  return {
    parties: partySnaps,
    fabrics: fabricSnaps,
    colors: colorSnaps,
    rolls: rollSnaps,
  };
}

/**
 * Capture deps for return replay. Sale returns add stock; entry returns remove it —
 * reconstruct pre-return remaining accordingly. Fabric/color derived from rolls.
 */
export async function captureReturnSyncDependencies(
  repos: {
    partyRepo: IPartyRepository;
    fabricRepo: IFabricRepository;
    colorRepo: IColorRepository;
    rollRepo: IRollRepository;
  },
  createInput: CreateReturnInput,
  ctx: TenantContext,
): Promise<InvoiceSyncDependencies> {
  const partyIds = new Set<string>([createInput.partyId]);
  const rollIds = new Set(createInput.lines.map((l) => l.rollId));

  const kgDeltaByRoll = new Map<string, number>();
  const piecesDeltaByRoll = new Map<string, number>();
  for (const line of createInput.lines) {
    kgDeltaByRoll.set(line.rollId, (kgDeltaByRoll.get(line.rollId) ?? 0) + Number(line.quantityKg));
    piecesDeltaByRoll.set(
      line.rollId,
      (piecesDeltaByRoll.get(line.rollId) ?? 0) + Number(line.pieces ?? 1),
    );
  }

  const partySnaps: SyncPartySnapshot[] = [];
  const fabricSnaps: SyncFabricSnapshot[] = [];
  const colorSnaps: SyncColorSnapshot[] = [];
  const rollSnaps: SyncRollSnapshot[] = [];
  const fabricIds = new Set<string>();
  const colorIds = new Set<string>();

  for (const id of rollIds) {
    const r = await repos.rollRepo.findById(id, ctx);
    if (!r) continue;
    if (r.supplierId) partyIds.add(r.supplierId);
    colorIds.add(r.colorId);

    const kgDelta = kgDeltaByRoll.get(id) ?? 0;
    const piecesDelta = piecesDeltaByRoll.get(id) ?? 0;
    let remainingKg = Number(r.remainingKg);
    let remainingPieces = Number(r.remainingPieces);
    // After local apply: sale return increased remaining; entry return decreased it.
    if (createInput.kind === "sale") {
      remainingKg = Math.max(0, remainingKg - kgDelta);
      remainingPieces = Math.max(0, remainingPieces - piecesDelta);
    } else {
      remainingKg += kgDelta;
      remainingPieces += piecesDelta;
    }

    rollSnaps.push({
      id: r.id,
      colorId: r.colorId,
      rollNo: r.rollNo,
      dyeBatch: r.dyeBatch ?? null,
      initialKg: Number(r.initialKg),
      remainingKg,
      pieces: r.pieces,
      remainingPieces,
      pricePerKg: Number(r.pricePerKg),
      salePricePerKg: r.salePricePerKg != null ? Number(r.salePricePerKg) : null,
      currency: r.currency,
      supplierId: r.supplierId ?? null,
      entryDate: r.entryDate,
      widthCm: r.widthCm != null ? Number(r.widthCm) : null,
      weightGsm: r.weightGsm != null ? Number(r.weightGsm) : null,
      status: r.status,
    });
  }

  for (const id of colorIds) {
    const c = await repos.colorRepo.findById(id, ctx);
    if (!c) continue;
    fabricIds.add(c.fabricId);
    colorSnaps.push({
      id: c.id,
      fabricId: c.fabricId,
      name: c.name,
      code: c.code ?? null,
      hex: c.hex ?? null,
      imageUrl: c.imageUrl ?? null,
    });
  }

  for (const id of fabricIds) {
    const f = await repos.fabricRepo.findById(id, ctx);
    if (!f) continue;
    fabricSnaps.push({
      id: f.id,
      name: f.name,
      category: f.category ?? null,
      minStockKg: f.minStockKg,
      unit: f.unit ?? null,
      notes: f.notes ?? null,
      imageUrl: f.imageUrl ?? null,
    });
  }

  for (const id of partyIds) {
    const p = await repos.partyRepo.findById(id, ctx);
    if (!p) continue;
    partySnaps.push(toPartySnapshot(p));
  }

  return {
    parties: partySnaps,
    fabrics: fabricSnaps,
    colors: colorSnaps,
    rolls: rollSnaps,
  };
}

/**
 * Ensure dependency rows exist with the same UUIDs (insert-if-missing only).
 * Does not rewrite existing rows — avoids clobbering divergent local state.
 *
 * The whole set applies in ONE database transaction (SYNC-08): without it a
 * crash between the party insert and the roll insert leaves a half-applied
 * dependency set — a concurrent reader sees masters without their rolls, and
 * a replay that passed the party check can still fail on the missing roll.
 * The transaction makes the set all-or-nothing; retries remain idempotent
 * because every insert is still guarded by its own existence check.
 */
export async function ensureInvoiceSyncDependencies(
  database: DB,
  deps: InvoiceSyncDependencies,
  ctx: TenantContext,
): Promise<void> {
  await runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
    await database.transaction(async (tx) => {
      await ensureInvoiceSyncDependenciesInTx(tx, deps, ctx);
    });
  });
}

/**
 * True when a tombstone guards this (tenant, type, id) — i.e. the row was
 * DELETED and must not be silently resurrected by a dependency snapshot
 * replay (plan §10). A deleted fabric/color/roll/party referenced by a later
 * invoice/return must not be re-inserted by this insert-if-missing path.
 * Best-effort: a lookup failure proceeds (safe default, the FK on the
 * referencing document still fails closed and surfaces visibly).
 */
export async function syncTombstoneBlocksDependency(
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  try {
    const r = await pool.query(
      `SELECT 1 FROM sync_tombstones
        WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
        LIMIT 1`,
      [tenantId, entityType, entityId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, entityType, entityId }, "sync tombstone dependency check failed");
    return false;
  }
}

/** Transaction-scoped body of {@link ensureInvoiceSyncDependencies}. */
async function ensureInvoiceSyncDependenciesInTx(
  tx: Parameters<Parameters<DB["transaction"]>[0]>[0],
  deps: InvoiceSyncDependencies,
  ctx: TenantContext,
): Promise<void> {
  for (const p of deps.parties ?? []) {
    const [existing] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, p.id), eq(parties.tenantId, ctx.tenantId)))
      .limit(1);
    if (existing) continue;
    // §10: never resurrect a deleted master through a dependency snapshot.
    if (await syncTombstoneBlocksDependency(ctx.tenantId, "party", p.id)) continue;
    try {
      await tx.insert(parties).values({
        id: p.id,
        tenantId: ctx.tenantId,
        kind: p.kind,
        code: p.code ?? null,
        name: p.name,
        companyName: p.companyName ?? null,
        commercialReg: p.commercialReg ?? null,
        category: p.category ?? null,
        salesRep: p.salesRep ?? null,
        phone: p.phone ?? null,
        mobile: p.mobile ?? null,
        whatsapp: p.whatsapp ?? null,
        altPhone: p.altPhone ?? null,
        email: p.email ?? null,
        website: p.website ?? null,
        address: p.address ?? null,
        city: p.city ?? null,
        country: p.country ?? null,
        taxNumber: p.taxNumber ?? null,
        // Opening balance is not re-journaled here — invoice ledger legs carry AR/AP.
        openingBalance: 0,
        creditLimit: 0,
        currency: p.currency || "SYP",
        paymentTerms: p.paymentTerms ?? null,
        paymentMethod: p.paymentMethod ?? null,
        defaultDiscount: p.defaultDiscount ?? 0,
        vat: p.vat != null ? String(p.vat) : "0",
        status: p.status || "active",
        notes: p.notes ?? null,
        createdBy: ctx.userId,
      });
    } catch (err) {
      logger.warn(
        { err, partyId: p.id },
        "sync party insert skipped (likely natural-key conflict)",
      );
      throw err;
    }
  }

  for (const f of deps.fabrics ?? []) {
    const [existing] = await tx
      .select({ id: fabrics.id })
      .from(fabrics)
      .where(and(eq(fabrics.id, f.id), eq(fabrics.tenantId, ctx.tenantId)))
      .limit(1);
    if (existing) continue;
    if (await syncTombstoneBlocksDependency(ctx.tenantId, "fabric", f.id)) continue;
    await tx.insert(fabrics).values({
      id: f.id,
      tenantId: ctx.tenantId,
      name: f.name,
      category: f.category ?? null,
      minStockKg: f.minStockKg != null ? String(f.minStockKg) : "0",
      unit: f.unit ?? null,
      notes: f.notes ?? null,
      imageUrl: f.imageUrl ?? null,
      createdBy: ctx.userId,
    });
  }

  for (const c of deps.colors ?? []) {
    const [existing] = await tx
      .select({ id: colors.id })
      .from(colors)
      .where(and(eq(colors.id, c.id), eq(colors.tenantId, ctx.tenantId)))
      .limit(1);
    if (existing) continue;
    if (await syncTombstoneBlocksDependency(ctx.tenantId, "color", c.id)) continue;
    await tx.insert(colors).values({
      id: c.id,
      tenantId: ctx.tenantId,
      fabricId: c.fabricId,
      name: c.name,
      code: c.code ?? null,
      hex: c.hex ?? null,
      imageUrl: c.imageUrl ?? null,
    });
  }

  for (const r of deps.rolls ?? []) {
    const [existing] = await tx
      .select({ id: rolls.id })
      .from(rolls)
      .where(and(eq(rolls.id, r.id), eq(rolls.tenantId, ctx.tenantId)))
      .limit(1);
    if (existing) continue;
    if (await syncTombstoneBlocksDependency(ctx.tenantId, "roll", r.id)) continue;
    await tx.insert(rolls).values({
      id: r.id,
      tenantId: ctx.tenantId,
      colorId: r.colorId,
      rollNo: r.rollNo,
      dyeBatch: r.dyeBatch ?? null,
      initialKg: String(r.initialKg),
      remainingKg: String(r.remainingKg),
      pieces: r.pieces,
      remainingPieces: r.remainingPieces,
      pricePerKg: String(r.pricePerKg),
      salePricePerKg: r.salePricePerKg != null ? String(r.salePricePerKg) : null,
      currency: r.currency || "SYP",
      supplierId: r.supplierId ?? null,
      entryDate: r.entryDate,
      widthCm: r.widthCm != null ? String(r.widthCm) : null,
      weightGsm: r.weightGsm != null ? String(r.weightGsm) : null,
      status: r.status || "in_stock",
      version: 1,
    });
  }
}

export function parseDependenciesPayload(
  payload: Record<string, unknown>,
): InvoiceSyncDependencies | null {
  const deps = payload.dependencies;
  if (!deps || typeof deps !== "object") return null;
  const d = deps as InvoiceSyncDependencies;
  return {
    parties: Array.isArray(d.parties) ? d.parties : [],
    fabrics: Array.isArray(d.fabrics) ? d.fabrics : [],
    colors: Array.isArray(d.colors) ? d.colors : [],
    rolls: Array.isArray(d.rolls) ? d.rolls : [],
  };
}
