// PORTED-FROM: src/infrastructure/repositories/financialYearRepository.ts sha256=05d6b6ef0c5eafbb594716e08c956b2c5ae3743427d59ec4044f71c30dd36550
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { scaledTextSql, greatest, least } from "./likeContains.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../../../orm/sqlite/drizzleCompat.js";
import { financialYears } from "../../../orm/sqlite/schemas/financial-year.table.js";
import { inventoryCounts } from "../../../orm/sqlite/schemas/inventory-count.table.js";
import { rolls } from "../../../orm/sqlite/schemas/roll.table.js";
import { ledgerEntries } from "../../../orm/sqlite/schemas/ledger-entry.table.js";
import { yearlyPartySummaries } from "../../../orm/sqlite/schemas/yearly-party-summary.table.js";
import { auditLogs } from "../../../orm/sqlite/schemas/audit-log.table.js";
import { parties } from "../../../orm/sqlite/schemas/party.table.js";
import { lockYear } from "./dayLockHelper.js";
import { getCashboxBalanceAsOf } from "./cashboxBalanceHelper.js";
import type { TenantContext } from "../../../../domain/types/index.js";
import { BusinessRuleError } from "../../../../domain/errors/index.js";
import { round2dp } from "@erp/shared";

/**
 * Year-end closing.
 *
 * ── The one rule that shapes everything here ────────────────────────────────
 * Closing a year FREEZES it and takes SNAPSHOTS. It never moves, archives,
 * truncates or rewrites a single financial row. `invoices`, `invoice_lines`,
 * `ledger_entries`, `vouchers`, `stock_movements`, `returns` and `expenses` are
 * untouched, so a closed year stays fully readable and printable forever.
 *
 * ── Why no "opening" ledger row is written ─────────────────────────────────
 * The ledger is RUNNING by design:
 *   • `getBalance()`       = SUM(debit) − SUM(credit), unbounded
 *   • `getBalanceByDate()` = same, bounded only above by `date`
 *   • statement            = prevByCurrency (everything before fromDate)
 *                           + the window's own totals
 * Posting an `opening` entry on Jan 1 of the new year carrying the 2026
 * balance would be read by ALL of those as a SECOND copy of money already
 * counted — a 4,500 debt would become 9,000. The carried balance is therefore
 * recorded as a snapshot in `yearly_party_summaries` (and `closing_cashbox`)
 * for display and reporting, while the ledger stays one continuous history.
 *
 * This is what makes requirement #7 true: the 2027 opening balance is 4,500
 * AND the 2026 invoices and payments remain fully queryable — because there was
 * never anything to migrate. The single continuous ledger answers both.
 *
 * ── Atomicity ──────────────────────────────────────────────────────────────
 * Every step runs in the caller's transaction. The per-(tenant, year) advisory
 * lock serialises concurrent closes; the UNIQUE (tenant_id, year) constraint is
 * the backstop. Any throw unwinds the whole thing — there is no state in which
 * the count is posted but the year is not marked closed, or vice versa.
 */

export type YearClosingSnapshot = {
  year: number;
  periodStart: string;
  periodEnd: string;
  status: "closed";
  closedAt: string;
  /** Per-currency drawer balance at the close instant. Display/audit only. */
  closingCashbox: Record<string, number>;
  /** Per-currency count of parties that carried a non-zero balance forward. */
  carriedParties: Record<string, number>;
  /** What the count sheet posted: kg gained vs lost, and how many lines. */
  inventoryVariance: { gainsKg: number; lossesKg: number; netKg: number; lines: number };
  /** Per-currency closing stock value, at each roll's own cost. */
  closingInventoryValue: Record<string, number>;
};

export type YearClosingPreview = Awaited<ReturnType<typeof getYearClosingPreview>>;

/** Currencies this tenant actually transacts in — no hard-coded SYP/USD pair. */
async function activeCurrencies(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ currency: ledgerEntries.currency })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.tenantId, tenantId))
    .groupBy(ledgerEntries.currency);
  const sessions = (await tx.execute(
    sql`SELECT DISTINCT currency FROM cashbox_sessions WHERE tenant_id = ${tenantId}`,
  )) as unknown as { rows?: Array<{ currency: string }> };
  const all = new Set<string>([
    ...rows.map((r) => r.currency),
    ...(sessions.rows ?? []).map((r) => r.currency),
  ]);
  all.delete("");
  // Deterministic order keeps the snapshot jsonb stable for diffing.
  return [...all].sort();
}

async function stockValueByCurrency(tx: Tx, tenantId: string): Promise<Record<string, number>> {
  // At each roll's own cost — the same basis the rest of the system uses
  // (invoice_lines.cost_per_kg snapshots rolls.price_per_kg).
  const rows = await tx
    .select({
      currency: rolls.currency,
      // kg(2) × price(4) = scale 6, exact; PG numeric text → Number() as before
      value: scaledTextSql(sql`COALESCE(SUM(${rolls.remainingKg} * ${rolls.pricePerKg}), 0)`, 6),
    })
    .from(rolls)
    .where(and(eq(rolls.tenantId, tenantId), sql`${rolls.remainingKg} > 0`))
    .groupBy(rolls.currency);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.currency] = round2dp(Number(r.value ?? 0));
  return out;
}

/**
 * Read-only: everything the close screen and the validation checklist need, with
 * no writes at all. Safe to call as often as the UI likes.
 */
export async function getYearClosingPreview(
  tx: Tx,
  ctx: TenantContext,
  year: number,
): Promise<{
  year: number;
  periodStart: string;
  periodEnd: string;
  status: string;
  closingCashbox: Record<string, number>;
  closingInventoryValue: Record<string, number>;
  counts: {
    rolls: number;
    counted: number;
    pending: number;
    posted: number;
    withVariance: number;
    gainsKg: number;
    lossesKg: number;
  };
  blockers: string[];
}> {
  const periodStart = `${year}-01-01`;
  const periodEnd = `${year}-12-31`;
  const [fy] = await tx
    .select({ status: financialYears.status })
    .from(financialYears)
    .where(and(eq(financialYears.tenantId, ctx.tenantId), eq(financialYears.year, year)))
    .limit(1);

  const currencies = await activeCurrencies(tx, ctx.tenantId);
  const closingCashbox: Record<string, number> = {};
  for (const c of currencies) {
    closingCashbox[c] = round2dp(await getCashboxBalanceAsOf(tx, ctx, c, periodEnd));
  }
  const closingInventoryValue = await stockValueByCurrency(tx, ctx.tenantId);

  const [countRow] = await tx
    .select({
      // distinct: a roll re-counted after a post has two lines
      counted: sql<number>`count(DISTINCT ${inventoryCounts.rollId}) FILTER (WHERE ${inventoryCounts.countedKg} IS NOT NULL)`,
      posted: sql<number>`count(*) FILTER (WHERE ${inventoryCounts.status} = 'posted')`,
      variance: sql<number>`count(*) FILTER (WHERE COALESCE(${inventoryCounts.diffKg}, 0) <> 0)`,
      gains: scaledTextSql(sql`COALESCE(SUM(${greatest(inventoryCounts.diffKg, sql`0`)}), 0)`, 2),
      losses: scaledTextSql(sql`COALESCE(SUM(${least(inventoryCounts.diffKg, sql`0`)}), 0)`, 2),
    })
    .from(inventoryCounts)
    .where(and(eq(inventoryCounts.tenantId, ctx.tenantId), eq(inventoryCounts.year, year)));

  const [rollsInYear] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(rolls)
    .where(
      and(
        eq(rolls.tenantId, ctx.tenantId),
        sql`${rolls.remainingKg} > 0`,
        sql`CAST(substr(${rolls.entryDate}, 1, 4) AS INTEGER) <= ${year}`,
      ),
    );

  const counted = Number(countRow?.counted ?? 0);
  const totalRolls = Number(rollsInYear?.n ?? 0);

  // ── Validation checklist (requirement #12) ──────────────────────────────
  const blockers: string[] = [];
  if (fy?.status === "closed") blockers.push(`سنة ${year} مقفلة مسبقاً.`);
  if (fy?.status === "counting" && totalRolls > 0 && counted < totalRolls) {
    blockers.push(`الجرد غير مكتمل: ${counted} من ${totalRolls} لفة. أكمل العدّ قبل الإقفال.`);
  }

  // An unposted variance would close the books while the shelf disagrees.
  const [unposted] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(inventoryCounts)
    .where(
      and(
        eq(inventoryCounts.tenantId, ctx.tenantId),
        eq(inventoryCounts.year, year),
        sql`COALESCE(${inventoryCounts.diffKg}, 0) <> 0`,
        sql`${inventoryCounts.status} <> 'posted'`,
      ),
    );
  if (Number(unposted?.n ?? 0) > 0) {
    blockers.push(`${unposted?.n} فرق جرد لم يُرحَّل كحركة تسوية. رحّلها قبل الإقفال.`);
  }

  // Double-entry sanity.
  //
  // A document's legs balance as a SET (see `invoice-ledger-legs-balance.test.ts`:
  // a sale writes sales_invoice + sales_revenue + inventory_asset +
  // cogs_expense), so the invariant has to be checked per DOCUMENT — grouping
  // by date, or filtering out the party leg, both break a set that legitimately
  // balances and would block the close on any tenant that has made a sale.
  // Documents with no reference id (manual/adjustment rows) are excluded: they
  // are single-sided by design.
  const unbalancedDocs = tx
    .select({
      rt: ledgerEntries.referenceType,
      rid: ledgerEntries.referenceId,
      d: scaledTextSql(sql`SUM(${ledgerEntries.debit})`, 2),
      c: scaledTextSql(sql`SUM(${ledgerEntries.credit})`, 2),
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, ctx.tenantId),
        sql`${ledgerEntries.date} >= ${periodStart}`,
        sql`${ledgerEntries.date} <= ${periodEnd}`,
        eq(ledgerEntries.status, "active"),
        isNotNull(ledgerEntries.referenceId),
        sql`${ledgerEntries.referenceType} IN ('sales_invoice','purchase_invoice','receipt_in','payment_out')`,
      ),
    )
    .groupBy(ledgerEntries.referenceType, ledgerEntries.referenceId)
    .having(sql`SUM(${ledgerEntries.debit}) <> SUM(${ledgerEntries.credit})`)
    .as("unbalanced_docs");
  const [unbalanced] = await tx.select({ n: sql<number>`count(*)` }).from(unbalancedDocs);
  if (Number(unbalanced?.n ?? 0) > 0) {
    blockers.push(
      `يوجد ${unbalanced?.n} مستند بقيود غير متوازنة (مدين ≠ دائن) داخل ${year}.`,
    );
  }

  return {
    year,
    periodStart,
    periodEnd,
    status: fy?.status ?? "open",
    closingCashbox,
    closingInventoryValue,
    counts: {
      rolls: totalRolls,
      counted,
      pending: Math.max(0, totalRolls - counted),
      posted: Number(countRow?.posted ?? 0),
      withVariance: Number(countRow?.variance ?? 0),
      gainsKg: round2dp(Number(countRow?.gains ?? 0)),
      lossesKg: round2dp(Number(countRow?.losses ?? 0)),
    },
    blockers,
  };
}

/**
 * Snapshot every party's balance for the closing year.
 *
 * `openingBalance` = balance carried IN (everything before Jan 1 of `year`),
 * `closingBalance` = balance carried OUT. Both are SUMs executed by PostgreSQL
 * over the CONTINUOUS ledger — no row is written to `ledger_entries`, so no
 * reader can double-count. These rows exist so a multi-year report can render
 * a year summary without scanning the whole ledger.
 */
async function writeYearlyPartySnapshots(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  currencies: string[],
): Promise<Record<string, number>> {
  const periodStart = `${year}-01-01`;
  const periodEnd = `${year}-12-31`;
  const carried: Record<string, number> = {};

  for (const currency of currencies) {
    const rows = await tx
      .select({
        partyId: ledgerEntries.partyId,
        net: scaledTextSql(sql`SUM(${ledgerEntries.debit} - ${ledgerEntries.credit})`, 2),
        before: scaledTextSql(sql`COALESCE(SUM(CASE WHEN ${ledgerEntries.date} < ${periodStart} THEN ${ledgerEntries.debit} - ${ledgerEntries.credit} ELSE 0 END), 0)`, 2),
        inYearD: scaledTextSql(sql`COALESCE(SUM(CASE WHEN ${ledgerEntries.date} >= ${periodStart} THEN ${ledgerEntries.debit} ELSE 0 END), 0)`, 2),
        inYearC: scaledTextSql(sql`COALESCE(SUM(CASE WHEN ${ledgerEntries.date} >= ${periodStart} THEN ${ledgerEntries.credit} ELSE 0 END), 0)`, 2),
      })
      .from(ledgerEntries)
      .innerJoin(parties, eq(parties.id, ledgerEntries.partyId))
      .where(
        and(
          eq(ledgerEntries.tenantId, ctx.tenantId),
          eq(ledgerEntries.currency, currency),
          eq(ledgerEntries.status, "active"),
          sql`${ledgerEntries.date} <= ${periodEnd}`,
        ),
      )
      .groupBy(ledgerEntries.partyId);

    for (const r of rows) {
      if (!r.partyId) continue;
      const net = round2dp(Number(r.net ?? 0));
      if (net === 0) continue;
      carried[currency] = (carried[currency] ?? 0) + 1;
      const before = round2dp(Number(r.before ?? 0));
      const d = round2dp(Number(r.inYearD ?? 0));
      const c = round2dp(Number(r.inYearC ?? 0));
      await tx
        .insert(yearlyPartySummaries)
        .values({
          tenantId: ctx.tenantId,
          partyId: r.partyId,
          year,
          currency,
          openingBalance: before,
          closingBalance: net,
          totalDebit: d,
          totalCredit: c,
        })
        .onConflictDoUpdate({
          target: [
            yearlyPartySummaries.tenantId,
            yearlyPartySummaries.partyId,
            yearlyPartySummaries.year,
            yearlyPartySummaries.currency,
          ],
          set: {
            openingBalance: before,
            closingBalance: net,
            totalDebit: d,
            totalCredit: c,
            generatedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }
  }
  return carried;
}

/**
 * Close the year. Runs entirely inside the caller's transaction.
 *
 * Order is validate → lock → snapshot parties and drawer → mark closed →
 * audit. Nothing is deleted at any point, so a rollback simply unwinds the
 * snapshots and the flag: there is no state where the count is posted but the
 * year is not closed, or the reverse.
 */
export async function closeFinancialYear(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  reason?: string,
): Promise<YearClosingSnapshot> {
  // Serialise concurrent closes of the SAME year. The second caller blocks here,
  // then re-reads status inside the preview and is rejected — no double close.
  await lockYear(tx, ctx.tenantId, year);

  const preview = await getYearClosingPreview(tx, ctx, year);
  if (preview.blockers.length > 0) {
    throw new BusinessRuleError(`لا يمكن الإقفال: ${preview.blockers.join(" ")}`);
  }

  const currencies = await activeCurrencies(tx, ctx.tenantId);
  const carriedParties = await writeYearlyPartySnapshots(tx, ctx, year, currencies);
  const closingInventoryValue = await stockValueByCurrency(tx, ctx.tenantId);
  const closedAt = new Date();

  // UPSERT so a year already opened as `counting` closes in place. The UNIQUE
  // (tenant_id, year) index remains the database-level backstop.
  await tx
    .insert(financialYears)
    .values({
      tenantId: ctx.tenantId,
      year,
      status: "closed",
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      closedAt,
      closedBy: ctx.userId,
      closingCashbox: preview.closingCashbox,
      closingInventoryValue,
      notes: reason ?? null,
    })
    .onConflictDoUpdate({
      target: [financialYears.tenantId, financialYears.year],
      set: {
        status: "closed",
        closedAt,
        closedBy: ctx.userId,
        closingCashbox: preview.closingCashbox,
        closingInventoryValue,
        updatedAt: closedAt,
      },
    });

  await tx.insert(auditLogs).values({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    actorName: ctx.userName,
    module: "financial_years",
    action: "close_year",
    entityType: "financial_year",
    detail: `إقفال السنة ${year}${reason ? ` — ${reason}` : ""}`,
    beforeSnapshot: { status: preview.status },
    afterSnapshot: {
      status: "closed",
      closingCashbox: preview.closingCashbox,
      closingInventoryValue,
      carriedParties,
    },
  });

  return {
    year,
    periodStart: preview.periodStart,
    periodEnd: preview.periodEnd,
    status: "closed",
    closedAt: closedAt.toISOString(),
    closingCashbox: preview.closingCashbox,
    carriedParties,
    inventoryVariance: {
      gainsKg: preview.counts.gainsKg,
      lossesKg: preview.counts.lossesKg,
      netKg: round2dp(preview.counts.gainsKg + preview.counts.lossesKg),
      lines: preview.counts.withVariance,
    },
    closingInventoryValue,
  };
}

/**
 * Reopen a closed year. Admin-only is enforced at the route layer; here we
 * enforce the state transition and ALWAYS write the audit trail.
 *
 * This deletes and reverses nothing: no ledger row, invoice, voucher or stock
 * movement is touched. It clears the freeze so the operator can post the
 * correcting document in the year it belongs to — and the reopen stays
 * permanently visible in the activity log.
 */
export async function reopenFinancialYear(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  reason: string,
): Promise<{ year: number; status: "open" }> {
  await lockYear(tx, ctx.tenantId, year);
  if (!reason.trim()) {
    throw new BusinessRuleError("سبب إعادة الفتح إلزامي ويُسجَّل في سجل النشاط.");
  }

  const [row] = await tx
    .select({ status: financialYears.status })
    .from(financialYears)
    .where(and(eq(financialYears.tenantId, ctx.tenantId), eq(financialYears.year, year)))
    .limit(1);
  if (!row) throw new BusinessRuleError(`سنة ${year} غير موجودة.`);
  if (row.status !== "closed") throw new BusinessRuleError(`سنة ${year} ليست مقفلة.`);

  const reopenedAt = new Date();
  await tx
    .update(financialYears)
    .set({
      status: "open",
      reopenedAt,
      reopenedBy: ctx.userId,
      reopenReason: reason,
      updatedAt: reopenedAt,
    })
    .where(and(eq(financialYears.tenantId, ctx.tenantId), eq(financialYears.year, year)));

  await tx.insert(auditLogs).values({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    actorName: ctx.userName,
    module: "financial_years",
    action: "reopen_year",
    entityType: "financial_year",
    detail: `إعادة فتح السنة ${year} — ${reason}`,
    beforeSnapshot: { status: "closed" },
    afterSnapshot: { status: "open" },
  });

  return { year, status: "open" };
}

/** Open (or return to) the `counting` state — where the count sheet lives. */
export async function beginYearCounting(
  tx: Tx,
  ctx: TenantContext,
  year: number,
): Promise<{ year: number; status: string }> {
  await lockYear(tx, ctx.tenantId, year);
  const [row] = await tx
    .select({ status: financialYears.status })
    .from(financialYears)
    .where(and(eq(financialYears.tenantId, ctx.tenantId), eq(financialYears.year, year)))
    .limit(1);
  if (row?.status === "closed") {
    throw new BusinessRuleError(`سنة ${year} مقفلة. أعد فتحها أولاً لتجراء الجرد.`);
  }
  if (row) {
    await tx
      .update(financialYears)
      .set({ status: "counting", updatedAt: new Date() })
      .where(and(eq(financialYears.tenantId, ctx.tenantId), eq(financialYears.year, year)));
  } else {
    await tx.insert(financialYears).values({
      tenantId: ctx.tenantId,
      year,
      status: "counting",
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
    });
  }
  return { year, status: "counting" };
}

/** Years, newest first — drives the year picker. */
export async function listFinancialYears(
  tx: Tx,
  ctx: TenantContext,
): Promise<Array<{ year: number; status: string; closedAt: Date | null }>> {
  return tx
    .select({
      year: financialYears.year,
      status: financialYears.status,
      closedAt: financialYears.closedAt,
    })
    .from(financialYears)
    .where(eq(financialYears.tenantId, ctx.tenantId))
    .orderBy(sql`${financialYears.year} DESC`);
}