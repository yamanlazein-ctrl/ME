/**
 * REPAIR-012 / REPAIR-019 — lock rolls in ascending id order in one statement.
 */
import { sql, inArray, eq, and, asc } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { BusinessRuleError } from "../../domain/errors/index.js";

export type LockedRollRow = {
  id: string;
  remainingKg: string | number;
  remainingPieces: string | number;
  version: number;
  status: string;
  pricePerKg: string | number | null;
  colorId: string;
  currency: string;
  rollNo: string;
  fabricId: string;
};

/**
 * SELECT … FOR UPDATE OF rolls ORDER BY id.
 * De-duplicates ids. Throws the existing Arabic "roll not found" message for the first missing id.
 */
export async function lockRollsOrdered(
  tx: Tx,
  tenantId: string,
  rollIds: string[],
): Promise<Map<string, LockedRollRow>> {
  const unique = [...new Set(rollIds.filter(Boolean))];
  const map = new Map<string, LockedRollRow>();
  if (unique.length === 0) return map;

  const rows = await tx
    .select({
      id: rolls.id,
      remainingKg: rolls.remainingKg,
      remainingPieces: rolls.remainingPieces,
      version: rolls.version,
      status: rolls.status,
      pricePerKg: rolls.pricePerKg,
      colorId: rolls.colorId,
      currency: rolls.currency,
      rollNo: rolls.rollNo,
      fabricId: colors.fabricId,
    })
    .from(rolls)
    .innerJoin(colors, eq(colors.id, rolls.colorId))
    .where(and(eq(rolls.tenantId, tenantId), inArray(rolls.id, unique)))
    .orderBy(asc(rolls.id))
    .for("update", { of: rolls });

  for (const r of rows) {
    map.set(r.id, r as LockedRollRow);
  }

  for (const id of unique) {
    if (!map.has(id)) {
      throw new BusinessRuleError(
        "الصبغة المحددة لأحد البنود غير موجودة (ربما حُذفت) — أعد اختيار الصبغة",
      );
    }
  }
  return map;
}

/** Documented global lock order (REPAIR-012). */
export const RESOURCE_LOCK_ORDER = [
  "1. cashbox advisory lock (tenant:cashbox:ccy) — only when cash moves",
  "2. invoice row(s) — ORDER BY id",
  "3. party row — only where locked today",
  "4. rolls — ORDER BY id (lockRollsOrdered)",
  "5. document_sequences / number blocks",
  "6. ledger / stock_movements / outbox inserts",
] as const;

/** Keep sql import referenced for future raw FOR UPDATE helpers. */
void sql;
