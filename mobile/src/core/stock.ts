// Stock as the warehouse sees it on the desktop's inventory page: fabric → colour → dye lot (صبغة) with its pieces
// (أثواب). One search covers fabric name, category, colour name, colour code and dye-lot number, like the desktop's
// search box. Quantities are the rolls' remaining kg (exact scaled integers summed in SQL); a dye lot's state uses the
// desktop's rule (src/presentation/hooks/useInventory.ts rollStatus).
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
  ilikeContains,
  scaledNumber,
} from "@backend/infrastructure/repositories/sqlite/helpers/likeContains";
import { fabrics } from "@backend/infrastructure/orm/sqlite/schemas/fabric.table";
import { colors } from "@backend/infrastructure/orm/sqlite/schemas/color.table";
import { rolls } from "@backend/infrastructure/orm/sqlite/schemas/roll.table";
import { parties } from "@backend/infrastructure/orm/sqlite/schemas/party.table";
import type { Phone } from "./phone";

export type LotState = "active" | "low" | "out";

/** The desktop's dye-lot state: out at 0 kg, low at or under max(half the fabric minimum, 10 kg). */
export function lotState(remainingKg: number, fabricMinKg: number): LotState {
  if (remainingKg <= 0) return "out";
  if (remainingKg <= Math.max(fabricMinKg * 0.5, 10)) return "low";
  return "active";
}

export const LOT_STATE_LABEL: Record<LotState, string> = {
  active: "نشطة",
  low: "منخفضة",
  out: "منتهية",
};

/** The desktop dashboard's low-stock rule for a fabric total. */
export function isLowStock(remainingKg: number, minStockKg: number): boolean {
  return minStockKg > 0 && remainingKg < minStockKg;
}

export type StockFilter = "all" | "inStock" | "low" | "out";

export interface FabricStock {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  minStockKg: number;
  remainingKg: number;
  pieces: number;
  /** Dye lots that still hold stock. */
  activeLots: number;
  colorCount: number;
  /** Fabric total under its minimum (the desktop dashboard's low-stock rule). */
  low: boolean;
}

export interface LotMatch {
  id: string;
  rollNo: string;
  fabricId: string;
  fabricName: string;
  colorName: string;
  remainingKg: number;
  remainingPieces: number;
}

function term(q: string): string {
  return q.trim();
}

/** Fabrics with their stock; `q` also matches a fabric through any of its colours or dye lots. */
export async function listFabrics(
  phone: Phone,
  q: string,
  filter: StockFilter = "all",
  category: string | null = null,
): Promise<FabricStock[]> {
  const tenantId = phone.identity.tenantId;
  const t = term(q);
  const match = t
    ? or(
        ilikeContains(fabrics.name, t),
        ilikeContains(sql`COALESCE(${fabrics.category}, '')`, t),
        sql`EXISTS (SELECT 1 FROM ${colors} c2 WHERE c2.fabric_id = ${fabrics.id} AND c2.tenant_id = ${tenantId}
              AND (${ilikeContains(sql.raw("c2.name"), t)} OR ${ilikeContains(sql.raw("COALESCE(c2.code, '')"), t)}))`,
        sql`EXISTS (SELECT 1 FROM ${rolls} r2 JOIN ${colors} c3 ON c3.id = r2.color_id
              WHERE c3.fabric_id = ${fabrics.id} AND r2.tenant_id = ${tenantId}
              AND (${ilikeContains(sql.raw("r2.roll_no"), t)} OR ${ilikeContains(sql.raw("COALESCE(r2.dye_batch, '')"), t)}))`,
      )
    : undefined;
  const rows = await phone.repos.db
    .select({
      id: fabrics.id,
      name: fabrics.name,
      category: fabrics.category,
      unit: fabrics.unit,
      minStockKg: fabrics.minStockKg,
      remainingKg: scaledNumber(sql`COALESCE(SUM(${rolls.remainingKg}), 0)`, 2),
      pieces: sql<number>`COALESCE(SUM(${rolls.remainingPieces}), 0)`,
      activeLots: sql<number>`COUNT(CASE WHEN ${rolls.remainingKg} > 0 THEN 1 END)`,
      colorCount: sql<number>`COUNT(DISTINCT ${colors.id})`,
    })
    .from(fabrics)
    .leftJoin(colors, and(eq(colors.fabricId, fabrics.id), eq(colors.tenantId, tenantId)))
    .leftJoin(rolls, and(eq(rolls.colorId, colors.id), eq(rolls.tenantId, tenantId)))
    .where(
      and(
        eq(fabrics.tenantId, tenantId),
        match,
        category ? eq(fabrics.category, category) : undefined,
      ),
    )
    .groupBy(fabrics.id, fabrics.name, fabrics.category, fabrics.unit, fabrics.minStockKg)
    .orderBy(asc(fabrics.name))
    .limit(300);
  const out = rows.map((r) => {
    const min = Number(r.minStockKg ?? 0);
    const remainingKg = Number(r.remainingKg);
    return {
      id: r.id,
      name: r.name,
      category: r.category ?? null,
      unit: r.unit ?? "kg",
      minStockKg: min,
      remainingKg,
      pieces: Number(r.pieces),
      activeLots: Number(r.activeLots),
      colorCount: Number(r.colorCount),
      low: isLowStock(remainingKg, min),
    };
  });
  if (filter === "inStock") return out.filter((f) => f.remainingKg > 0);
  if (filter === "low") return out.filter((f) => f.low && f.remainingKg > 0);
  if (filter === "out") return out.filter((f) => f.remainingKg <= 0);
  return out;
}

/** The fabric categories in use, for the filter chips. */
export async function listCategories(phone: Phone): Promise<string[]> {
  const rows = await phone.repos.db
    .selectDistinct({ category: fabrics.category })
    .from(fabrics)
    .where(
      and(
        eq(fabrics.tenantId, phone.identity.tenantId),
        sql`${fabrics.category} IS NOT NULL AND ${fabrics.category} <> ''`,
      ),
    )
    .orderBy(asc(fabrics.category));
  return rows.map((r) => String(r.category));
}

/** Dye lots whose number (or dye batch) matches: a direct jump to the lot from the search box. */
export async function findLots(phone: Phone, q: string): Promise<LotMatch[]> {
  const t = term(q);
  if (t.length < 2) return [];
  const tenantId = phone.identity.tenantId;
  const rows = await phone.repos.db
    .select({
      id: rolls.id,
      rollNo: rolls.rollNo,
      fabricId: fabrics.id,
      fabricName: fabrics.name,
      colorName: colors.name,
      remainingKg: rolls.remainingKg,
      remainingPieces: rolls.remainingPieces,
    })
    .from(rolls)
    .innerJoin(colors, eq(colors.id, rolls.colorId))
    .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
    .where(
      and(
        eq(rolls.tenantId, tenantId),
        or(ilikeContains(rolls.rollNo, t), ilikeContains(sql`COALESCE(${rolls.dyeBatch}, '')`, t)),
      ),
    )
    .orderBy(desc(rolls.remainingKg))
    .limit(20);
  return rows.map((r) => ({
    id: r.id,
    rollNo: r.rollNo,
    fabricId: r.fabricId,
    fabricName: r.fabricName,
    colorName: r.colorName,
    remainingKg: Number(r.remainingKg),
    remainingPieces: Number(r.remainingPieces ?? 0),
  }));
}

export interface FabricDetail {
  fabric: FabricStock & { notes: string | null };
  colors: Array<{
    id: string;
    name: string;
    code: string | null;
    hex: string | null;
    remainingKg: number;
    pieces: number;
    activeLots: number;
    totalLots: number;
  }>;
}

export async function loadFabric(phone: Phone, fabricId: string): Promise<FabricDetail | null> {
  const tenantId = phone.identity.tenantId;
  const [head] = await phone.repos.db
    .select({ notes: fabrics.notes })
    .from(fabrics)
    .where(and(eq(fabrics.id, fabricId), eq(fabrics.tenantId, tenantId)))
    .limit(1);
  if (!head) return null;
  const all = await listFabrics(phone, "");
  const fabric = all.find((f) => f.id === fabricId);
  if (!fabric) return null;
  const rows = await phone.repos.db
    .select({
      id: colors.id,
      name: colors.name,
      code: colors.code,
      hex: colors.hex,
      remainingKg: scaledNumber(sql`COALESCE(SUM(${rolls.remainingKg}), 0)`, 2),
      pieces: sql<number>`COALESCE(SUM(${rolls.remainingPieces}), 0)`,
      activeLots: sql<number>`COUNT(CASE WHEN ${rolls.remainingKg} > 0 THEN 1 END)`,
      totalLots: sql<number>`COUNT(${rolls.id})`,
    })
    .from(colors)
    .leftJoin(rolls, and(eq(rolls.colorId, colors.id), eq(rolls.tenantId, tenantId)))
    .where(and(eq(colors.tenantId, tenantId), eq(colors.fabricId, fabricId)))
    .groupBy(colors.id, colors.name, colors.code, colors.hex)
    .orderBy(asc(colors.name))
    .limit(500);
  return {
    fabric: { ...fabric, notes: head.notes ?? null },
    colors: rows.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code ?? null,
      hex: r.hex ?? null,
      remainingKg: Number(r.remainingKg),
      pieces: Number(r.pieces),
      activeLots: Number(r.activeLots),
      totalLots: Number(r.totalLots),
    })),
  };
}

export interface LotRow {
  id: string;
  rollNo: string;
  dyeBatch: string | null;
  initialKg: number;
  remainingKg: number;
  remainingPieces: number;
  pieces: number;
  supplierName: string | null;
  entryDate: string | null;
  state: LotState;
}

export interface ColorLots {
  fabricId: string;
  fabricName: string;
  fabricMinKg: number;
  colorName: string;
  colorCode: string | null;
  hex: string | null;
  lots: LotRow[];
}

/** The dye lots of one colour, with supplier and entry date, newest first (as the desktop lists them). */
export async function loadColorLots(phone: Phone, colorId: string): Promise<ColorLots | null> {
  const tenantId = phone.identity.tenantId;
  const [head] = await phone.repos.db
    .select({
      fabricId: fabrics.id,
      fabricName: fabrics.name,
      fabricMinKg: fabrics.minStockKg,
      colorName: colors.name,
      colorCode: colors.code,
      hex: colors.hex,
    })
    .from(colors)
    .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
    .where(and(eq(colors.id, colorId), eq(colors.tenantId, tenantId)))
    .limit(1);
  if (!head) return null;
  const rows = await phone.repos.db
    .select({
      id: rolls.id,
      rollNo: rolls.rollNo,
      dyeBatch: rolls.dyeBatch,
      initialKg: rolls.initialKg,
      remainingKg: rolls.remainingKg,
      remainingPieces: rolls.remainingPieces,
      pieces: rolls.pieces,
      supplierName: parties.name,
      entryDate: rolls.entryDate,
    })
    .from(rolls)
    .leftJoin(parties, and(eq(parties.id, rolls.supplierId), eq(parties.tenantId, tenantId)))
    .where(and(eq(rolls.tenantId, tenantId), eq(rolls.colorId, colorId)))
    .orderBy(desc(rolls.entryDate), asc(rolls.rollNo))
    .limit(500);
  const min = Number(head.fabricMinKg ?? 0);
  return {
    fabricId: head.fabricId,
    fabricName: head.fabricName,
    fabricMinKg: min,
    colorName: head.colorName,
    colorCode: head.colorCode ?? null,
    hex: head.hex ?? null,
    lots: rows.map((r) => {
      const remainingKg = Number(r.remainingKg);
      return {
        id: r.id,
        rollNo: r.rollNo,
        dyeBatch: r.dyeBatch ?? null,
        initialKg: Number(r.initialKg),
        remainingKg,
        remainingPieces: Number(r.remainingPieces ?? 0),
        pieces: Number(r.pieces ?? 0),
        supplierName: r.supplierName ?? null,
        entryDate: r.entryDate ? String(r.entryDate).slice(0, 10) : null,
        state: lotState(remainingKg, min),
      };
    }),
  };
}

export const MOVEMENT_LABEL: Record<string, string> = {
  initial: "رصيد افتتاحي",
  invoice_entry: "فاتورة شراء",
  invoice_sale: "فاتورة بيع",
  return_sale: "مرتجع بيع",
  return_entry: "مرتجع شراء",
  print_send: "إرسال للطباعة",
  print_receive: "استلام من الطباعة",
  print_waste: "هدر طباعة",
  adjustment: "تعديل يدوي",
};

export interface LotDetail {
  id: string;
  rollNo: string;
  version: number;
  fabricId: string;
  fabricName: string;
  colorId: string;
  colorName: string;
  colorCode: string | null;
  dyeBatch: string | null;
  initialKg: number;
  remainingKg: number;
  /** initial − remaining: what left the lot (sales, print, adjustments down, net of returns). */
  outKg: number;
  pieces: number;
  remainingPieces: number;
  widthCm: number | null;
  weightGsm: number | null;
  salePricePerKg: number | null;
  costPerKg: number;
  currency: string;
  entryPricePerKg: number | null;
  entryCurrency: string | null;
  supplierName: string | null;
  entryDate: string | null;
  entryReference: string | null;
  state: LotState;
  movements: Array<{
    id: string;
    label: string;
    direction: "in" | "out";
    quantityKg: number;
    balanceAfterKg: number;
    date: string;
    reference: string;
    referenceType: string | null;
    referenceId: string | null;
    cancelled: boolean;
  }>;
}

export async function loadLot(phone: Phone, rollId: string): Promise<LotDetail | null> {
  const ctx = phone.context();
  const roll = await phone.repos.rollRepo.findById(rollId, ctx);
  if (!roll) return null;
  const [head] = await phone.repos.db
    .select({
      fabricId: fabrics.id,
      fabricName: fabrics.name,
      fabricMinKg: fabrics.minStockKg,
      colorName: colors.name,
      colorCode: colors.code,
    })
    .from(colors)
    .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
    .where(and(eq(colors.id, roll.colorId), eq(colors.tenantId, ctx.tenantId)))
    .limit(1);
  const supplier = roll.supplierId
    ? await phone.repos.partyRepo.findById(roll.supplierId, ctx)
    : null;
  const moves = await phone.repos.stockMovementRepo.listByRoll(rollId, ctx, { limit: 100 });
  const r = roll as unknown as Record<string, unknown>;
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const initialKg = Number(roll.initialKg);
  const remainingKg = Number(roll.remainingKg);
  return {
    id: roll.id,
    rollNo: roll.rollNo,
    version: Number(roll.version ?? 0),
    fabricId: head?.fabricId ?? "",
    fabricName: head?.fabricName ?? "",
    colorId: roll.colorId,
    colorName: head?.colorName ?? "",
    colorCode: head?.colorCode ?? null,
    dyeBatch: roll.dyeBatch ?? null,
    initialKg,
    remainingKg,
    outKg: Math.round((initialKg - remainingKg) * 100) / 100,
    pieces: Number(r.pieces ?? 0),
    remainingPieces: Number(roll.remainingPieces ?? 0),
    widthCm: num(r.widthCm),
    weightGsm: num(r.weightGsm),
    salePricePerKg: num(r.salePricePerKg),
    costPerKg: Number(roll.pricePerKg ?? 0),
    currency: String(roll.currency ?? ""),
    entryPricePerKg: num(r.entryPricePerKg),
    entryCurrency: (r.entryCurrency as string | null) ?? null,
    supplierName: supplier?.name ?? null,
    entryDate: roll.entryDate ? String(roll.entryDate).slice(0, 10) : null,
    entryReference: (r.entryReference as string | null) ?? null,
    state: lotState(remainingKg, Number(head?.fabricMinKg ?? 0)),
    movements: moves.map((m) => ({
      id: m.id,
      label: MOVEMENT_LABEL[m.movementType] ?? m.movementType,
      direction: m.direction,
      quantityKg: Number(m.quantityKg),
      balanceAfterKg: Number(m.balanceAfterKg),
      date: String(m.movementDate).slice(0, 10),
      reference: m.referenceNumber ?? "",
      referenceType: m.referenceType ?? null,
      referenceId: (m.referenceId as string | null | undefined) ?? null,
      cancelled: (m as { status?: string }).status === "cancelled",
    })),
  };
}
