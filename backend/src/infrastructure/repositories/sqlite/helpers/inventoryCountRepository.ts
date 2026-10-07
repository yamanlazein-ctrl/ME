// PORTED-FROM: src/infrastructure/repositories/inventoryCountRepository.ts sha256=10a9b680d43bcd359b1f55fd1371210978064c54dd66acc04d1d990618abf51f
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../../orm/sqlite/drizzleCompat.js";
import { inventoryCounts } from "../../../orm/sqlite/schemas/inventory-count.table.js";
import { financialYears } from "../../../orm/sqlite/schemas/financial-year.table.js";
import { rolls } from "../../../orm/sqlite/schemas/roll.table.js";
import { colors } from "../../../orm/sqlite/schemas/color.table.js";
import { fabrics } from "../../../orm/sqlite/schemas/fabric.table.js";
import { ledgerEntries } from "../../../orm/sqlite/schemas/ledger-entry.table.js";
import { stockMovements } from "../../../orm/sqlite/schemas/stock-movement.table.js";
import { auditLogs } from "../../../orm/sqlite/schemas/audit-log.table.js";
import { lockYear } from "./dayLockHelper.js";
import type { TenantContext } from "../../../../domain/types/index.js";
import { BusinessRuleError } from "../../../../domain/errors/index.js";
import { round2dp } from "@erp/shared";
import { localToday } from "../../../utils/localDate.js";

/**
 * Physical inventory count, at the roll (the real unit of stock in this schema).
 *
 * ── A variance is a DOCUMENT, not a number edit ────────────────────────────
 * Posting a variance calls `recordStockMovement` with
 * `movementType: "adjustment"` inside the SAME transaction that mutates
 * `rolls.remaining_kg`, exactly like a sale, a return or a print receipt. The
 * stock ledger therefore stays the single append-only record of why stock
 * changed, and `rolls.remaining_kg` can never drift from it.
 *
 * The inventory side of the accounting entry is posted too, as an
 * `expense`-style leg with `cashImpact: 'none'`: a stock write-off is not a
 * cash movement, so the drawer must not move, while P&L still reflects it.
 */

export type CountLine = {
  /** Null until the roll has been counted; the id needed to post a variance. */
  countId: string | null;
  rollId: string;
  rollNo: string;
  fabricName: string;
  colorName: string;
  bookKg: number;
  bookPieces: number;
  countedKg: number | null;
  countedPieces: number | null;
  diffKg: number | null;
  diffPieces: number | null;
  /** Stock moved since the count (live − book at count); null when it did not or the line is not counted. */
  movedKg: number | null;
  movedPieces: number | null;
  /** Cost per kg and its currency: the screen values a difference at cost (never mixed). */
  pricePerKg: number;
  currency: string;
  status: string;
};

/**
 * The count sheet for a year: every roll that existed on or before the year end
 * and still holds stock, against its CURRENT book figures.
 *
 * Keyset-paginated by roll id so a tenant with thousands of rolls never
 * materialises them all in the WebView, and the labels are resolved in one extra
 * query instead of N+1 per line.
 */
export type CountSheetFilter = {
  limit?: number;
  cursor?: string;
  /** Fabric / colour name or code, roll number or dye batch. */
  q?: string;
  status?: "uncounted" | "counted" | "variance" | "posted";
  /** A count round: lines counted before this date (YYYY-MM-DD) show as not counted. */
  since?: string;
  /** Also rolls the system thinks are empty (stock found on them can be recorded). */
  includeEmpty?: boolean;
};

export async function getCountSheet(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  opts: CountSheetFilter = {},
): Promise<{ lines: CountLine[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));

  // Each roll's LATEST count line of the year (a roll can be re-counted after a post).
  const latest = sql`${inventoryCounts.id} = (SELECT c2.id FROM inventory_counts c2
    WHERE c2.tenant_id = ${ctx.tenantId} AND c2.roll_id = ${rolls.id} AND c2.year = ${year}${opts.since ? sql` AND substr(c2.counted_at, 1, 10) >= ${opts.since}` : sql``}
    ORDER BY c2.created_at DESC LIMIT 1)`;
  const countedCond = and(eq(inventoryCounts.tenantId, ctx.tenantId), eq(inventoryCounts.rollId, rolls.id), latest);
  const term = opts.q?.trim().toLowerCase();
  const like = term ? `%${term}%` : null;
  const filters = [
    eq(rolls.tenantId, ctx.tenantId),
    opts.includeEmpty ? undefined : sql`(${rolls.remainingKg} > 0 OR ${rolls.remainingPieces} > 0)`,
    sql`CAST(substr(${rolls.entryDate}, 1, 4) AS INTEGER) <= ${year}`,
    like
      ? sql`(lower(${rolls.rollNo}) LIKE ${like} OR lower(COALESCE(${rolls.dyeBatch}, '')) LIKE ${like}
          OR lower(${fabrics.name}) LIKE ${like} OR lower(${colors.name}) LIKE ${like} OR lower(COALESCE(${colors.code}, '')) LIKE ${like})`
      : undefined,
    opts.status === "uncounted" ? sql`${inventoryCounts.id} IS NULL` : undefined,
    opts.status === "counted" ? sql`${inventoryCounts.status} = 'counted'` : undefined,
    opts.status === "posted" ? sql`${inventoryCounts.status} = 'posted'` : undefined,
    opts.status === "variance"
      ? sql`${inventoryCounts.status} = 'counted' AND (COALESCE(${inventoryCounts.diffKg}, 0) <> 0 OR COALESCE(${inventoryCounts.diffPieces}, 0) <> 0)`
      : undefined,
  ];
  const base = and(...filters);
  const from = () =>
    tx
      .select({ roll: rolls, count: inventoryCounts, fabric: fabrics.name, color: colors.name })
      .from(rolls)
      .innerJoin(colors, eq(colors.id, rolls.colorId))
      .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
      .leftJoin(inventoryCounts, countedCond);
  // Keyset pagination on the roll id — no OFFSET, and never more than one
  // page of rolls in memory at a time.
  const rows = await from()
    .where(opts.cursor ? and(base, sql`${rolls.id} > ${opts.cursor.toLowerCase()}`) : base)
    .orderBy(sql`${rolls.id} ASC`)
    .limit(limit + 1);
  const labels = new Map(rows.map((r) => [r.roll.id, { fabric: r.fabric, color: r.color }]));

  const [totalRow] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(rolls)
    .innerJoin(colors, eq(colors.id, rolls.colorId))
    .innerJoin(fabrics, eq(fabrics.id, colors.fabricId))
    .leftJoin(inventoryCounts, countedCond)
    .where(base);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const lines: CountLine[] = page.map(({ roll, count }) => {
    const meta = labels.get(roll.id);
    const posted = count?.status === "posted";
    const counted = count != null && (count.countedKg != null || count.countedPieces != null);
    const liveKg = round2dp(Number(roll.remainingKg ?? 0));
    const livePieces = Number(roll.remainingPieces ?? 0);
    return {
      countId: count?.id ?? null,
      rollId: roll.id,
      rollNo: roll.rollNo,
      fabricName: meta?.fabric ?? "—",
      colorName: meta?.color ?? "—",
      // ONE basis for screen and posting: a counted line shows the book AT COUNT TIME (what
      // posting applies). If the shelf moved since, `moved*` says so and posting asks for a
      // re-count — the screen no longer shows a difference that will not be posted.
      bookKg: counted ? round2dp(Number(count!.bookKg)) : liveKg,
      bookPieces: counted ? Number(count!.bookPieces ?? 0) : livePieces,
      countedKg: count?.countedKg == null ? null : Number(count.countedKg),
      countedPieces: count?.countedPieces ?? null,
      diffKg: count?.countedKg == null ? null : round2dp(Number(count.countedKg) - Number(count.bookKg)),
      diffPieces: count?.countedPieces == null ? null : count.countedPieces - Number(count.bookPieces ?? 0),
      movedKg: counted && !posted && round2dp(liveKg - Number(count!.bookKg)) !== 0 ? round2dp(liveKg - Number(count!.bookKg)) : null,
      movedPieces: counted && !posted && livePieces !== Number(count!.bookPieces ?? 0) ? livePieces - Number(count!.bookPieces ?? 0) : null,
      pricePerKg: Number(roll.pricePerKg ?? 0),
      currency: roll.currency,
      status: count?.status ?? "uncounted",
    };
  });

  return {
    lines,
    nextCursor: hasMore && page.length ? page[page.length - 1]!.roll.id : null,
    total: Number(totalRow?.n ?? 0),
  };
}

/** Reject any count write while the target year is closed. */
async function assertYearNotClosed(tx: Tx, tenantId: string, year: number): Promise<void> {
  const [row] = await tx
    .select({ status: financialYears.status })
    .from(financialYears)
    .where(
      and(
        eq(financialYears.tenantId, tenantId),
        eq(financialYears.year, year),
        eq(financialYears.status, "closed"),
      ),
    )
    .limit(1);
  if (row) throw new BusinessRuleError(`سنة ${year} مقفلة ولا تقبل أي حركة جديدة.`);
}

/**
 * Record (or overwrite) the physical count for one roll.
 *
 * `bookKg` is the system quantity at the moment of THIS count: a re-count takes a
 * fresh snapshot, so the difference is never computed against a stale figure.
 * Difference = counted − book, per roll.
 */
export async function recordCount(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  rollId: string,
  countedKg: number | null,
  countedPieces: number | null,
  reason?: string,
): Promise<{ rollId: string; diffKg: number | null }> {
  await lockYear(tx, ctx.tenantId, year);
  await assertYearNotClosed(tx, ctx.tenantId, year);

  const [roll] = await tx
    .select({ id: rolls.id, remainingKg: rolls.remainingKg, remainingPieces: rolls.remainingPieces })
    .from(rolls)
    .where(and(eq(rolls.tenantId, ctx.tenantId), eq(rolls.id, rollId)))
    .limit(1);
  if (!roll) throw new BusinessRuleError("اللفة غير موجودة.");

  // One working line per roll and year. A re-count after a post reopens it with a fresh
  // book snapshot: the posted correction stays as its stock movement, ledger leg and audit
  // row (the real history), and posting the new count applies only the new difference.
  const [existing] = await tx
    .select()
    .from(inventoryCounts)
    .where(
      and(
        eq(inventoryCounts.tenantId, ctx.tenantId),
        eq(inventoryCounts.year, year),
        eq(inventoryCounts.rollId, rollId),
      ),
    )
    .limit(1);

  const bookKg = Number(roll.remainingKg ?? 0);
  const bookPieces = roll.remainingPieces ?? 0;
  const diffKg = countedKg == null ? null : round2dp(countedKg - bookKg);
  const diffPieces = countedPieces == null ? null : countedPieces - bookPieces;
  const now = new Date();

  if (existing) {
    await tx
      .update(inventoryCounts)
      .set({
        bookKg,
        bookPieces,
        countedKg,
        countedPieces,
        diffKg,
        diffPieces,
        reason: reason ?? (existing.status === "posted" ? null : existing.reason),
        status: "counted",
        approvedBy: null,
        approvedAt: null,
        postedMovementId: null,
        countedBy: ctx.userId,
        countedAt: now,
        updatedAt: now,
      })
      .where(eq(inventoryCounts.id, existing.id));
  } else {
    await tx.insert(inventoryCounts).values({
      tenantId: ctx.tenantId,
      year,
      rollId,
      bookKg,
      bookPieces,
      countedKg,
      countedPieces,
      diffKg,
      diffPieces,
      reason: reason ?? null,
      status: "counted",
      countedBy: ctx.userId,
      countedAt: now,
    });
  }

  return { rollId, diffKg };
}

/**
 * Post one counted variance as a real stock movement + accounting entry.
 *
 * Both happen in the caller's transaction:
 *   1. `rolls.remaining_kg` is moved to the counted figure (optimistic, on
 *      `version`, so a concurrent sale is detected rather than silently lost).
 *   2. `recordStockMovement` appends an `adjustment` row to the stock ledger
 *      carrying `balance_after_kg` — the same append-only discipline as every
 *      other stock change, so the shelf and its history can never disagree.
 *   3. A non-cash ledger leg records the P&L effect at the roll's own cost.
 *
 * Re-posting the same line is rejected: `status` is the idempotency marker, so
 * a double-clicked "post" cannot apply the variance twice.
 */
export async function postCountVariance(
  tx: Tx,
  ctx: TenantContext,
  countId: string,
): Promise<{ rollId: string; diffKg: number; movementId: string | null; adjustment: RollAdjustmentInput | null }> {
  const [count] = await tx
    .select()
    .from(inventoryCounts)
    .where(and(eq(inventoryCounts.tenantId, ctx.tenantId), eq(inventoryCounts.id, countId)))
    .limit(1);
  if (!count) throw new BusinessRuleError("سطر الجرد غير موجود.");
  if (count.status === "posted") {
    throw new BusinessRuleError("تم ترحيل هذه التسوية مسبقاً.");
  }
  if (count.countedKg == null) {
    throw new BusinessRuleError("لم يُدخل الرصيد الفعلي بعد.");
  }

  const diffKg = round2dp(Number(count.countedKg) - Number(count.bookKg));
  const diffPieces = count.countedPieces == null ? 0 : count.countedPieces - Number(count.bookPieces ?? 0);
  if (diffKg === 0 && diffPieces === 0) {
    // Nothing to adjust — mark it settled so it stops blocking the close.
    await tx
      .update(inventoryCounts)
      .set({ status: "posted", approvedBy: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(inventoryCounts.id, countId));
    return { rollId: count.rollId, diffKg, movementId: null, adjustment: null };
  }

  const [roll] = await tx
    .select()
    .from(rolls)
    .where(and(eq(rolls.tenantId, ctx.tenantId), eq(rolls.id, count.rollId)))
    .limit(1);
  if (!roll) throw new BusinessRuleError("اللفة غير موجودة.");
  // The count compared the shelf with the book quantity AT COUNT TIME. If stock
  // moved since (a sale, a return), the counted figure no longer describes the
  // shelf: posting it would erase that movement. Re-count first.
  if (
    round2dp(Number(roll.remainingKg ?? 0)) !== round2dp(Number(count.bookKg)) ||
    (count.countedPieces != null && (roll.remainingPieces ?? 0) !== Number(count.bookPieces ?? 0))
  ) {
    throw new BusinessRuleError(
      "تغيّر رصيد هذه اللفة بعد الجرد (حركة بيع/إرجاع). أعد عدّ اللفة ثم رحّل الفرق.",
    );
  }

  const adjustment: RollAdjustmentInput = {
    rollId: roll.id,
    deltaKg: diffKg,
    deltaPieces: count.countedPieces == null ? 0 : count.countedPieces - Number(count.bookPieces ?? 0),
    reason: count.reason ?? (diffKg > 0 ? "تسوية جرد: زيادة" : "تسوية جرد: عجز"),
    // Never in the future: a count during the year posts today; a year-end count done
    // after New Year still lands on 31 Dec of the year it closes.
    date: [localToday(), `${count.year}-12-31`].sort()[0]!,
    referenceType: "inventory_count",
    referenceId: count.id,
    referenceNumber: `CNT-${count.year}-${count.id.slice(0, 8)}`,
    expectedVersion: roll.version,
  };
  const adjusted = await applyRollAdjustment(tx, ctx, adjustment);

  await tx
    .update(inventoryCounts)
    .set({
      status: "posted",
      approvedBy: ctx.userId,
      approvedAt: new Date(),
      postedMovementId: adjusted.movementId,
      updatedAt: new Date(),
    })
    .where(eq(inventoryCounts.id, countId));

  return { rollId: roll.id, diffKg, movementId: adjusted.movementId, adjustment };
}

export type RollAdjustmentInput = {
  rollId: string;
  /** Change in kilograms (counted − book, or the operator's correction). */
  deltaKg: number;
  /** Change in pieces (أثواب). */
  deltaPieces: number;
  reason: string;
  /** Business date of the movement (YYYY-MM-DD). */
  date: string;
  referenceType: "inventory_count" | "inventory_adjustment";
  referenceId: string;
  referenceNumber: string;
  /** Optimistic lock: the roll version the operator saw. Null on sync replay (deltas converge). */
  expectedVersion: number | null;
};

/**
 * THE way a roll's quantity changes outside a document: one transaction moves
 * remaining kg/pieces by a delta, appends an `adjustment` stock movement (the
 * shelf and its history can never disagree), books the P&L at the roll's cost
 * (no cash), and writes an audit row (who, when, before, after, why). Used by a
 * posted inventory count, the manual adjustment, and the sync replay of either.
 */
export async function applyRollAdjustment(
  tx: Tx,
  ctx: TenantContext,
  input: RollAdjustmentInput,
): Promise<{ rollId: string; beforeKg: number; afterKg: number; beforePieces: number; afterPieces: number; movementId: string | null }> {
  const [roll] = await tx
    .select()
    .from(rolls)
    .where(and(eq(rolls.tenantId, ctx.tenantId), eq(rolls.id, input.rollId)))
    .limit(1);
  if (!roll) throw new BusinessRuleError("اللفة غير موجودة.");
  if (input.expectedVersion != null && roll.version !== input.expectedVersion) {
    throw new BusinessRuleError("تغيّرت كمية هذه اللفة على جهاز آخر أو في نافذة أخرى — حدّث الصفحة ثم أعد التعديل.");
  }
  const deltaKg = round2dp(Number(input.deltaKg) || 0);
  const deltaPieces = Math.trunc(Number(input.deltaPieces) || 0);
  if (deltaKg === 0 && deltaPieces === 0) throw new BusinessRuleError("لا يوجد تغيير في الكمية.");
  const beforeKg = round2dp(Number(roll.remainingKg ?? 0));
  const beforePieces = roll.remainingPieces ?? 0;
  const afterKg = round2dp(beforeKg + deltaKg);
  const afterPieces = beforePieces + deltaPieces;
  if (afterKg < 0 || afterPieces < 0) {
    throw new BusinessRuleError("لا يمكن أن تصبح الكمية أو عدد الأثواب سالبة.");
  }

  const [updated] = await tx
    .update(rolls)
    .set({ remainingKg: String(afterKg), remainingPieces: afterPieces, version: roll.version + 1, updatedAt: new Date() } as never)
    .where(and(eq(rolls.tenantId, ctx.tenantId), eq(rolls.id, roll.id), eq(rolls.version, roll.version)))
    .returning({ id: rolls.id });
  if (!updated) throw new BusinessRuleError("تغيّرت كمية هذه اللفة أثناء التعديل — أعد المحاولة.");

  let movementId: string | null = null;
  if (deltaKg !== 0) {
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        tenantId: ctx.tenantId,
        rollId: roll.id,
        direction: deltaKg > 0 ? "in" : "out",
        movementType: "adjustment",
        quantityKg: String(Math.abs(deltaKg)),
        balanceAfterKg: String(afterKg),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        referenceNumber: input.referenceNumber,
        movementDate: input.date,
        description: input.reason,
        createdBy: ctx.userId,
      })
      .returning({ id: stockMovements.id });
    movementId = movement?.id ?? null;

    // Inventory P&L leg. `cashImpact: 'none'` — a stock correction moves no cash.
    const amount = round2dp(Math.abs(deltaKg) * Number(roll.pricePerKg ?? 0));
    if (amount > 0) {
      await tx.insert(ledgerEntries).values({
        tenantId: ctx.tenantId,
        date: input.date,
        type: "expense",
        debit: deltaKg > 0 ? 0 : amount,
        credit: deltaKg > 0 ? amount : 0,
        currency: roll.currency,
        cashImpact: "none",
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        referenceNumber: input.referenceNumber,
        description: deltaKg > 0 ? `${input.reason} — زيادة مخزون` : `${input.reason} — عجز مخزون`,
        createdBy: ctx.userId,
      } as never);
    }
  }

  await tx.insert(auditLogs).values({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    actorName: ctx.userName,
    module: "inventory_adjustments",
    action: input.referenceType === "inventory_count" ? "post_count_variance" : "roll_adjust",
    entityType: "roll",
    entityId: roll.id,
    detail: input.reason,
    beforeSnapshot: { rollNo: roll.rollNo, remainingKg: beforeKg, remainingPieces: beforePieces },
    afterSnapshot: {
      rollNo: roll.rollNo,
      remainingKg: afterKg,
      remainingPieces: afterPieces,
      deltaKg,
      deltaPieces,
      reference: input.referenceNumber,
      movementId,
    },
  });

  return { rollId: roll.id, beforeKg, afterKg, beforePieces, afterPieces, movementId };
}
