// Inventory reads for the phone (FR-24, FR-25): fabrics with remaining kg and a low-stock flag, the colours of a fabric, the
// rolls of a colour, one roll with its movements, and the count sheet. The aggregates are SQL (SUM over exact scaled integers),
// the same expression the desktop dashboard uses for its low-stock count.
import { and, asc, eq, sql } from "drizzle-orm";
import {
  scaledNumber,
  ilikeContains,
} from "@backend/infrastructure/repositories/sqlite/helpers/likeContains";
import { fabrics } from "@backend/infrastructure/orm/sqlite/schemas/fabric.table";
import { colors } from "@backend/infrastructure/orm/sqlite/schemas/color.table";
import { rolls } from "@backend/infrastructure/orm/sqlite/schemas/roll.table";
import { inventoryCountHelpers } from "@backend/infrastructure/repositories/engineHelpers";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import type { Phone } from "./phone";

export interface FabricStockRow {
  id: string;
  name: string;
  minStockKg: number;
  remainingKg: number;
  rollCount: number;
  low: boolean;
}

export interface ColorStockRow {
  id: string;
  name: string;
  code: string | null;
  remainingKg: number;
  rollCount: number;
}

export interface RollRow {
  id: string;
  rollNo: string;
  remainingKg: number;
  remainingPieces: number;
  pricePerKg: number;
  currency: string;
  status: string;
  version: number;
}

/** A fabric is low when it has a minimum and the stock left is below it (the desktop's rule). */
export function isLowStock(remainingKg: number, minStockKg: number): boolean {
  return minStockKg > 0 && remainingKg < minStockKg;
}

export async function listFabricStock(phone: Phone, q: string): Promise<FabricStockRow[]> {
  const tenantId = phone.identity.tenantId;
  const term = q.trim();
  const rows = await phone.repos.db
    .select({
      id: fabrics.id,
      name: fabrics.name,
      minStockKg: fabrics.minStockKg,
      remainingKg: scaledNumber(sql`COALESCE(SUM(${rolls.remainingKg}), 0)`, 2),
      rollCount: sql<number>`COUNT(${rolls.id})`,
    })
    .from(fabrics)
    .leftJoin(colors, and(eq(colors.fabricId, fabrics.id), eq(colors.tenantId, tenantId)))
    .leftJoin(
      rolls,
      and(eq(rolls.colorId, colors.id), eq(rolls.tenantId, tenantId), eq(rolls.status, "in_stock")),
    )
    .where(
      and(eq(fabrics.tenantId, tenantId), term ? ilikeContains(fabrics.name, term) : undefined),
    )
    .groupBy(fabrics.id, fabrics.name, fabrics.minStockKg)
    .orderBy(asc(fabrics.name))
    .limit(200);
  return rows.map((r) => {
    const min = Number(r.minStockKg ?? 0);
    const remaining = Number(r.remainingKg);
    return {
      id: r.id,
      name: r.name,
      minStockKg: min,
      remainingKg: remaining,
      rollCount: Number(r.rollCount),
      low: isLowStock(remaining, min),
    };
  });
}

export async function listColorStock(phone: Phone, fabricId: string): Promise<ColorStockRow[]> {
  const tenantId = phone.identity.tenantId;
  const rows = await phone.repos.db
    .select({
      id: colors.id,
      name: colors.name,
      code: colors.code,
      remainingKg: scaledNumber(sql`COALESCE(SUM(${rolls.remainingKg}), 0)`, 2),
      rollCount: sql<number>`COUNT(${rolls.id})`,
    })
    .from(colors)
    .leftJoin(
      rolls,
      and(eq(rolls.colorId, colors.id), eq(rolls.tenantId, tenantId), eq(rolls.status, "in_stock")),
    )
    .where(and(eq(colors.tenantId, tenantId), eq(colors.fabricId, fabricId)))
    .groupBy(colors.id, colors.name, colors.code)
    .orderBy(asc(colors.name))
    .limit(300);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code ?? null,
    remainingKg: Number(r.remainingKg),
    rollCount: Number(r.rollCount),
  }));
}

export async function listRollsOfColor(phone: Phone, colorId: string): Promise<RollRow[]> {
  const page = await phone.repos.rollRepo.list({ colorId, limit: 200 }, phone.context());
  return page.data.map((r) => ({
    id: r.id,
    rollNo: r.rollNo,
    remainingKg: Number(r.remainingKg),
    remainingPieces: Number(r.remainingPieces ?? 0),
    pricePerKg: Number(r.pricePerKg ?? 0),
    currency: String(r.currency ?? ""),
    status: String(r.status),
    version: Number(r.version ?? 0),
  }));
}

export interface RollDetail {
  roll: RollRow & { initialKg: number; entryDate: string; dyeBatch: string | null };
  fabricName: string;
  colorName: string;
  movements: Array<{ id: string; type: string; deltaKg: number; date: string; reference: string }>;
}

export async function loadRollDetail(phone: Phone, rollId: string): Promise<RollDetail | null> {
  const ctx = phone.context();
  const roll = await phone.repos.rollRepo.findById(rollId, ctx);
  if (!roll) return null;
  const [labels] = await phone.repos.db
    .select({ fabric: fabrics.name, color: colors.name })
    .from(colors)
    .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
    .where(and(eq(colors.id, roll.colorId), eq(colors.tenantId, ctx.tenantId)))
    .limit(1);
  const moves = await phone.repos.stockMovementRepo.listByRoll(rollId, ctx, { limit: 50 });
  return {
    roll: {
      id: roll.id,
      rollNo: roll.rollNo,
      remainingKg: Number(roll.remainingKg),
      remainingPieces: Number(roll.remainingPieces ?? 0),
      pricePerKg: Number(roll.pricePerKg ?? 0),
      currency: String(roll.currency ?? ""),
      status: String(roll.status),
      version: Number(roll.version ?? 0),
      initialKg: Number(roll.initialKg),
      entryDate: String(roll.entryDate ?? ""),
      dyeBatch: roll.dyeBatch ?? null,
    },
    fabricName: labels?.fabric ?? "",
    colorName: labels?.color ?? "",
    movements: moves.map((m) => ({
      id: m.id,
      type: m.movementType,
      deltaKg: m.direction === "in" ? Number(m.quantityKg) : -Number(m.quantityKg),
      date: String(m.movementDate).slice(0, 10),
      reference: m.referenceNumber ?? m.referenceType ?? "",
    })),
  };
}

export interface CountLineRow {
  rollId: string;
  countId: string | null;
  rollNo: string;
  fabricName: string;
  colorName: string;
  bookKg: number;
  countedKg: number | null;
  diffKg: number | null;
  status: string;
}

export async function loadCountSheet(
  phone: Phone,
  year: number,
  q: string,
): Promise<{ lines: CountLineRow[]; total: number }> {
  const ctx = phone.context();
  const sheet = await withTenantTx(ctx.tenantId, async (tx) =>
    (await inventoryCountHelpers()).getCountSheet(tx as never, ctx, year, {
      limit: 100,
      ...(q.trim() ? { q: q.trim() } : {}),
    }),
  );
  return {
    total: Number(sheet.total),
    lines: sheet.lines.map((l) => {
      const x = l as unknown as Record<string, unknown>;
      return {
        rollId: String(x.rollId),
        countId: (x.countId as string | null | undefined) ?? null,
        rollNo: String(x.rollNo),
        fabricName: String(x.fabricName),
        colorName: String(x.colorName),
        bookKg: Number(x.bookKg),
        countedKg: x.countedKg == null ? null : Number(x.countedKg),
        diffKg: x.diffKg == null ? null : Number(x.diffKg),
        status: String(x.status),
      };
    }),
  };
}
