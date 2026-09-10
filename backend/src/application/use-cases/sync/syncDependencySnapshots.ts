import { and, eq } from "drizzle-orm";
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
    partySnaps.push({
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
    });
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
    partySnaps.push({
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
    });
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
    partySnaps.push({
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
    });
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
 */
export async function ensureInvoiceSyncDependencies(
  database: DB,
  deps: InvoiceSyncDependencies,
  ctx: TenantContext,
): Promise<void> {
  await runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
    for (const p of deps.parties ?? []) {
      const [existing] = await database
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.id, p.id), eq(parties.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      try {
        await database.insert(parties).values({
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
        logger.warn({ err, partyId: p.id }, "sync party insert skipped (likely natural-key conflict)");
        throw err;
      }
    }

    for (const f of deps.fabrics ?? []) {
      const [existing] = await database
        .select({ id: fabrics.id })
        .from(fabrics)
        .where(and(eq(fabrics.id, f.id), eq(fabrics.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      await database.insert(fabrics).values({
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
      const [existing] = await database
        .select({ id: colors.id })
        .from(colors)
        .where(and(eq(colors.id, c.id), eq(colors.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      await database.insert(colors).values({
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
      const [existing] = await database
        .select({ id: rolls.id })
        .from(rolls)
        .where(and(eq(rolls.id, r.id), eq(rolls.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      await database.insert(rolls).values({
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
  });
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
