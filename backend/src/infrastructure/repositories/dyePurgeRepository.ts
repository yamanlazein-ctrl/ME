import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../orm/drizzle.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { stockMovements } from "../orm/schemas/stock-movement.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { printJobs } from "../orm/schemas/print-job.table.js";
import { auditLogs } from "../orm/schemas/audit-log.table.js";

/**
 * Cascading dye (fabric) purge — the corrective path for an inventory master
 * entered by mistake together with everything it ever touched.
 *
 * ── One transaction, and why one trigger is dropped inside it ───────────────
 * `ledger_entries` is append-only by design (migrations 0013 / 0036b / 20261011):
 *
 *   CREATE TRIGGER trg_ledger_entries_append_only
 *   BEFORE UPDATE OR DELETE ON ledger_entries …
 *   RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
 *
 * A corrective purge must remove the entries it created, so the trigger is
 * dropped inside the transaction and re-created in a `finally`. PostgreSQL DDL
 * is transactional, so a failure anywhere rolls the trigger back together with
 * the data — fail-closed is preserved exactly.
 *
 * ── Why the drawer is rebuilt by hand ───────────────────────────────────────
 * `cashbox_daily_balances` is maintained by AFTER INSERT / AFTER UPDATE triggers
 * on `ledger_entries` (migration 20260928). There is no DELETE branch, so
 * deleting rows would leave the drawer holding money that no longer has an
 * entry — precisely the corrupted balance this feature exists to prevent. The
 * affected currency series is therefore rebuilt from the surviving movements.
 */

/**
 * Ledger reference types the invoice and payment paths write, split by the id
 * they are keyed on. `sales_invoice` / `purchase_invoice` (and their cancels) are
 * keyed by INVOICE id; `receipt_in` / `payment_out` are keyed by VOUCHER id.
 * Matching either group against the wrong id space is what leaves orphaned cash
 * legs behind, so the two are kept separate on purpose.
 */
const INVOICE_LEDGER_REF_TYPES = [
  "sales_invoice",
  "purchase_invoice",
  "sales_invoice_cancel",
  "purchase_invoice_cancel",
] as const;

const VOUCHER_LEDGER_REF_TYPES = ["receipt_in", "payment_out"] as const;

/** `IN (...)` list for a drizzle `sql` fragment. */
function refTypeList(types: readonly string[]): SQL {
  return sql`(${sql.join(types.map((t) => sql`${t}`), sql`, `)})`;
}

export type AffectedInvoice = {
  id: string;
  number: string;
  type: string;
  total: number;
};

export type DyePurgeImpact = {
  fabricId: string;
  fabricName: string | null;
  colorsCount: number;
  rollsCount: number;
  stockMovementsCount: number;
  ledgerEntriesCount: number;
  vouchersCount: number;
  otherBlocked: string[];
  affectedInvoices: AffectedInvoice[];
  cashDelta: { syp: number; usd: number };
  affectedCurrencies: string[];
  earliestDate: string | null;
};

export type DyePurgeResult = {
  fabricId: string;
  colorsDeleted: number;
  rollsDeleted: number;
  stockMovementsDeleted: number;
  invoicesDeleted: number;
  invoiceLinesDeleted: number;
  ledgerEntriesDeleted: number;
  vouchersDeleted: number;
  cashDelta: { syp: number; usd: number };
  currenciesRebuilt: string[];
};

export type PurgeActor = {
  id?: string | null;
  name?: string | null;
  reason?: string | null;
};

type Scope = {
  fabricId: string;
  fabricName: string | null;
  colorIds: string[];
  rollIds: string[];
  invoiceIds: string[];
  /**
   * Ids of the vouchers linked to the doomed invoices.
   *
   * These matter because a voucher's ledger legs are keyed by the VOUCHER id, not
   * the invoice id: `CreateReceiptVoucherUseCase` and the invoice-create path both
   * write `referenceType: "receipt_in" | "payment_out"` with
   * `referenceId: voucherRow.id`. Matching ledger rows on invoice ids alone would
   * leave those legs behind as orphans, and because the drawer is rebuilt from
   * `ledger_entries`, the cashbox would keep money for an invoice that no longer
   * exists — the exact corruption this purge exists to repair.
   */
  voucherIds: string[];
  currencies: string[];
  earliestDate: string | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

async function collectScope(tx: Tx, tenantId: string, fabricId: string): Promise<Scope> {
  const [fabric] = await tx
    .select({ id: fabrics.id, name: fabrics.name })
    .from(fabrics)
    .where(and(eq(fabrics.tenantId, tenantId), eq(fabrics.id, fabricId)))
    .limit(1);
  if (!fabric) {
    throw Object.assign(new Error("DYE_NOT_FOUND"), { code: "DYE_NOT_FOUND" });
  }

  const colorRows = await tx
    .select({ id: colors.id })
    .from(colors)
    .where(and(eq(colors.tenantId, tenantId), eq(colors.fabricId, fabricId)));
  const colorIds = colorRows.map((c) => c.id);

  const rollRows = colorIds.length
    ? await tx
        .select({ id: rolls.id })
        .from(rolls)
        .where(and(eq(rolls.tenantId, tenantId), inArray(rolls.colorId, colorIds)))
    : [];
  const rollIds = rollRows.map((r) => r.id);

  // An invoice is in scope when ANY of its lines touched this fabric, one of
  // its colors, or one of its rolls.
  const clauses = [sql`${invoiceLines.fabricId} = ${fabricId}::uuid`];
  if (colorIds.length) {
    clauses.push(sql`${invoiceLines.colorId} IN (${sql.join(colorIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (rollIds.length) {
    clauses.push(sql`${invoiceLines.rollId} IN (${sql.join(rollIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  const lines = await tx
    .select({ invoiceId: invoiceLines.invoiceId, currency: invoices.currency, date: invoices.date })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.tenantId, tenantId),
        sql`(${sql.join(clauses, sql` OR `)})`,
      ),
    );

  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))];
  const currencies = [...new Set(lines.map((l) => l.currency))].sort();
  const dates = lines.map((l) => isoDate(l.date)).sort();

  // Vouchers settled against the doomed invoices. Collected BEFORE any delete so
  // their ledger legs can be matched in the same pass.
  const voucherIds =
    invoiceIds.length === 0
      ? []
      : (
          await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(and(eq(vouchers.tenantId, tenantId), inArray(vouchers.invoiceId, invoiceIds)))
        ).map((v) => v.id);

  return {
    fabricId: fabric.id,
    fabricName: fabric.name,
    colorIds,
    rollIds,
    invoiceIds,
    voucherIds,
    currencies,
    earliestDate: dates.length ? dates[0] : null,
  };
}

async function countStockMovements(tx: Tx, tenantId: string, rollIds: string[]): Promise<number> {
  if (rollIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockMovements)
    .where(and(eq(stockMovements.tenantId, tenantId), inArray(stockMovements.rollId, rollIds)));
  return row?.n ?? 0;
}

async function countVouchers(tx: Tx, tenantId: string, invoiceIds: string[]): Promise<number> {
  if (invoiceIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(vouchers)
    .where(and(eq(vouchers.tenantId, tenantId), inArray(vouchers.invoiceId, invoiceIds)));
  return row?.n ?? 0;
}

async function countOrderItems(tx: Tx, tenantId: string, fabricId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.fabricId, fabricId)));
  return row?.n ?? 0;
}

async function countReturnLines(tx: Tx, tenantId: string, rollIds: string[]): Promise<number> {
  if (rollIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(returnLines)
    .where(and(eq(returnLines.tenantId, tenantId), inArray(returnLines.rollId, rollIds)));
  return row?.n ?? 0;
}

async function countPrintJobs(tx: Tx, tenantId: string, fabricIds: string[]): Promise<number> {
  if (fabricIds.length === 0) return 0;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(and(eq(printJobs.tenantId, tenantId), inArray(printJobs.sourceFabricId, fabricIds)));
  return row?.n ?? 0;
}

/**
 * Predicate matching every ledger leg belonging to the doomed documents: the
 * invoice-keyed legs and the voucher-keyed cash legs.
 *
 * The dry run and the delete MUST agree on this predicate — a row counted in the
 * impact sheet but not deleted (or vice versa) is exactly the drift this feature
 * is meant to eliminate. Returns null when nothing is in scope, so the caller can
 * skip the query entirely instead of issuing a match-nothing statement.
 */
function scopedLedgerPredicate(
  invoiceIds: string[],
  voucherIds: string[],
): SQL | null {
  const conds = [
    ...invoiceIds.map(
      (id) =>
        sql`(${ledgerEntries.referenceId} = ${id}::uuid AND ${ledgerEntries.referenceType} IN ${refTypeList(
          INVOICE_LEDGER_REF_TYPES,
        )})`,
    ),
    ...voucherIds.map(
      (id) =>
        sql`(${ledgerEntries.referenceId} = ${id}::uuid AND ${ledgerEntries.referenceType} IN ${refTypeList(
          VOUCHER_LEDGER_REF_TYPES,
        )})`,
    ),
  ];
  return conds.length === 0 ? null : sql`(${sql.join(conds, sql` OR `)})`;
}

async function selectScopedLedger(
  tx: Tx,
  tenantId: string,
  invoiceIds: string[],
  voucherIds: string[],
): Promise<
  { debit: number | null; credit: number | null; currency: string; cashImpact: string }[]
> {
  // Two key spaces, one query: invoice-keyed legs (`sales_invoice` /
  // `purchase_invoice` / their cancels) and voucher-keyed legs (`receipt_in` /
  // `payment_out`). Restricting the reference id to invoices would silently skip
  // every cash leg, so both sets are matched explicitly.
  const pred = scopedLedgerPredicate(invoiceIds, voucherIds);
  if (!pred) return [];
  return tx
    .select({
      debit: ledgerEntries.debit,
      credit: ledgerEntries.credit,
      currency: ledgerEntries.currency,
      // Needed to tell a CASH leg from a party leg: only cash_impact in/out
      // moves the drawer.
      cashImpact: ledgerEntries.cashImpact,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenantId), pred));
}

/** Read-only dry run: what a purge WOULD remove. Writes nothing. */
export async function computeDyePurgeImpact(
  tx: Tx,
  tenantId: string,
  fabricId: string,
): Promise<DyePurgeImpact> {
  const scope = await collectScope(tx, tenantId, fabricId);

  const invoiceRows = scope.invoiceIds.length
    ? await tx
        .select({
          id: invoices.id,
          number: invoices.number,
          type: invoices.type,
          total: invoices.total,
        })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, scope.invoiceIds)))
        .orderBy(invoices.date)
    : [];

  const ledgerRows = await selectScopedLedger(tx, tenantId, scope.invoiceIds, scope.voucherIds);

  // Cash the drawer will LOSE: only the CASH legs of the doomed documents.
  //
  // A document is written as a balanced SET — a cash-paid sale posts
  // sales_invoice (Dr AR, cash_impact 'none'), sales_revenue, inventory_asset,
  // cogs_expense and the receipt_in pair (party leg 'none' + cash leg 'in').
  // Summing debit+credit over every leg therefore counts the same money three
  // times and showed the operator a figure ~3x the real one. Only
  // cash_impact in/out moves the drawer, and the sign is the direction:
  // 'in' added money, so removing it leaves the drawer lower by that amount.
  const cashDelta = { syp: 0, usd: 0 };
  for (const l of ledgerRows) {
    if (l.cashImpact !== "in" && l.cashImpact !== "out") continue;
    const amount = Number(l.debit ?? 0) + Number(l.credit ?? 0);
    if (l.currency === "USD") cashDelta.usd -= amount;
    else cashDelta.syp -= amount;
  }

  // What the purge deliberately does NOT touch. Surfacing it is the point: the
  // operator must see what survives before confirming.
  const otherBlocked: string[] = [];
  const ord = await countOrderItems(tx, tenantId, fabricId);
  if (ord) otherBlocked.push(`${ord} طلبية`);
  const ret = await countReturnLines(tx, tenantId, scope.rollIds);
  if (ret) otherBlocked.push(`${ret} سطر مرتجع`);
  const print = await countPrintJobs(tx, tenantId, [fabricId]);
  if (print) otherBlocked.push(`${print} أمر طباعة`);

  return {
    fabricId: scope.fabricId,
    fabricName: scope.fabricName,
    colorsCount: scope.colorIds.length,
    rollsCount: scope.rollIds.length,
    stockMovementsCount: await countStockMovements(tx, tenantId, scope.rollIds),
    ledgerEntriesCount: ledgerRows.length,
    vouchersCount: await countVouchers(tx, tenantId, scope.invoiceIds),
    otherBlocked,
    affectedInvoices: invoiceRows.map((r) => ({
      id: r.id,
      number: r.number,
      type: r.type,
      total: Number(r.total ?? 0),
    })),
    cashDelta: { syp: round2(cashDelta.syp), usd: round2(cashDelta.usd) },
    affectedCurrencies: scope.currencies,
    earliestDate: scope.earliestDate,
  };
}

/**
 * Rebuild the per-day drawer series for the given currencies from the
 * movements that survive.
 *
 * The whole series is rebuilt rather than a suffix because `closing_balance` is
 * cumulative: a windowed sum from the first movement is the only value that
 * cannot drift from `ledger_entries` + `manual_movements`.
 */
async function rebuildCashboxSeries(tx: Tx, tenantId: string, currencies: string[]): Promise<void> {
  if (currencies.length === 0) return;
  // A JS array bound to `::varchar[]` arrives as ONE text value ("SYP"), so
  // `= ANY(...)` raised `malformed array literal: "SYP"`. Build a proper IN list
  // instead — the list is server-generated, never user input, so there is no
  // injection surface.
  const inList = sql`(${sql.join(currencies.map((c) => sql`${c}`), sql`, `)})`;
  await tx.execute(
    sql`DELETE FROM cashbox_daily_balances
        WHERE tenant_id = ${tenantId}::uuid
          AND currency IN ${inList}`,
  );
  await tx.execute(
    sql`
    INSERT INTO cashbox_daily_balances (tenant_id, currency, balance_date, closing_balance, updated_at)
    SELECT ${tenantId}::uuid,
           d.currency,
           d.day,
           sum(d.daily_delta) OVER (PARTITION BY d.currency ORDER BY d.day)::numeric(14,2),
           now()
    FROM (
      -- Daily total FIRST. Selecting m.delta alongside a window over the same
      -- grouping level made PostgreSQL raise
      --   "column m.delta must appear in the GROUP BY clause"
      -- because several movements can share a day.
      SELECT m.currency, m.d AS day, sum(m.delta) AS daily_delta
      FROM (
        SELECT currency, date AS d,
               (CASE cash_impact WHEN 'in' THEN 1 ELSE -1 END)
                 * (COALESCE(debit,0) + COALESCE(credit,0)) AS delta
        FROM ledger_entries
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'active'
          AND cash_impact IN ('in','out')
        UNION ALL
        SELECT currency, date AS d,
               (CASE direction WHEN 'in' THEN 1 ELSE -1 END) * amount AS delta
        FROM manual_movements
        WHERE tenant_id = ${tenantId}::uuid
      ) m
      WHERE m.currency IN ${inList}
      GROUP BY m.currency, m.d
    ) d`,
  );
}

/** Cash the drawer holds for these currencies AFTER the deletions. */
async function survivingCash(
  tx: Tx,
  tenantId: string,
  currencies: string[],
): Promise<{ syp: number; usd: number }> {
  if (currencies.length === 0) return { syp: 0, usd: 0 };
  const rows = await tx
    .select({
      currency: ledgerEntries.currency,
      total: sql<string>`sum(COALESCE(debit,0)+COALESCE(credit,0))`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, tenantId),
        eq(ledgerEntries.status, "active"),
        inArray(ledgerEntries.cashImpact, ["in", "out"]),
        inArray(ledgerEntries.currency, currencies),
      ),
    )
    .groupBy(ledgerEntries.currency);
  const out = { syp: 0, usd: 0 };
  for (const r of rows) {
    const v = round2(Number(r.total ?? 0));
    if (r.currency === "USD") out.usd += v;
    else out.syp += v;
  }
  return out;
}

/**
 * Delete a dye and everything it touched, atomically.
 *
 * Order is reverse dependency: payments and journal entries (which reference
 * the invoice), then lines, then the invoice, then stock movements, rolls,
 * colors, and finally the fabric itself. Any error propagates so the caller's
 * transaction rolls back to zero change.
 */
export async function purgeDyeCascade(
  tx: Tx,
  tenantId: string,
  fabricId: string,
  actor: PurgeActor,
): Promise<DyePurgeResult> {
  const scope = await collectScope(tx, tenantId, fabricId);
  const before = await survivingCash(tx, tenantId, scope.currencies);

  await tx.execute(sql`DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries`);
  try {
    // 1. payments / receipts tied to the affected invoices
    const deletedVouchers = scope.invoiceIds.length
      ? await tx
          .delete(vouchers)
          .where(and(eq(vouchers.tenantId, tenantId), inArray(vouchers.invoiceId, scope.invoiceIds)))
          .returning({ id: vouchers.id })
      : [];

    // 2. journal entries for those documents — invoice-keyed legs AND the
    //    voucher-keyed cash legs, which are keyed by voucher id (see Scope).
    //    Same predicate the impact sheet counted with, so the two cannot drift.
    const ledgerPred = scopedLedgerPredicate(scope.invoiceIds, scope.voucherIds);
    const deletedLedger = ledgerPred
      ? await tx
          .delete(ledgerEntries)
          .where(and(eq(ledgerEntries.tenantId, tenantId), ledgerPred))
          .returning({ id: ledgerEntries.id })
      : [];

    // 3. invoice lines, then the invoices
    const deletedLines = scope.invoiceIds.length
      ? await tx
          .delete(invoiceLines)
          .where(and(eq(invoiceLines.tenantId, tenantId), inArray(invoiceLines.invoiceId, scope.invoiceIds)))
          .returning({ id: invoiceLines.id })
      : [];

    // A line can reference the fabric without its invoice being in scope (a
    // roll that was later unlinked). Sweep by fabric so nothing is orphaned.
    const orphanLines = await tx
      .delete(invoiceLines)
      .where(and(eq(invoiceLines.tenantId, tenantId), eq(invoiceLines.fabricId, fabricId)))
      .returning({ id: invoiceLines.id });

    const deletedInvoices = scope.invoiceIds.length
      ? await tx
          .delete(invoices)
          .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.id, scope.invoiceIds)))
          .returning({ id: invoices.id })
      : [];

    // 4. stock movements, then rolls
    const deletedMoves = scope.rollIds.length
      ? await tx
          .delete(stockMovements)
          .where(and(eq(stockMovements.tenantId, tenantId), inArray(stockMovements.rollId, scope.rollIds)))
          .returning({ id: stockMovements.id })
      : [];

    const deletedRolls = scope.rollIds.length
      ? await tx
          .delete(rolls)
          .where(and(eq(rolls.tenantId, tenantId), inArray(rolls.id, scope.rollIds)))
          .returning({ id: rolls.id })
      : [];

    // 5. colors, 6. the fabric itself
    const deletedColors = scope.colorIds.length
      ? await tx
          .delete(colors)
          .where(and(eq(colors.tenantId, tenantId), inArray(colors.id, scope.colorIds)))
          .returning({ id: colors.id })
      : [];

    await tx
      .delete(fabrics)
      .where(and(eq(fabrics.tenantId, tenantId), eq(fabrics.id, fabricId)));

    // 7. the drawer — no trigger fires on DELETE, so rebuild it.
    if (scope.currencies.length) {
      await rebuildCashboxSeries(tx, tenantId, scope.currencies);
    }
    const after = await survivingCash(tx, tenantId, scope.currencies);

    await tx.insert(auditLogs).values({
      tenantId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      module: "inventory",
      action: "dye_cascade_purge",
      entityType: "fabric",
      entityId: fabricId,
      detail: actor.reason ?? "cascading corrective purge",
      beforeSnapshot: {
        fabricName: scope.fabricName,
        colors: scope.colorIds.length,
        rolls: scope.rollIds.length,
        invoices: deletedInvoices.length,
        invoiceLines: deletedLines.length + orphanLines.length,
        ledgerEntries: deletedLedger.length,
        vouchers: deletedVouchers.length,
        stockMovements: deletedMoves.length,
        cashBefore: before,
        cashAfter: after,
        currenciesRebuilt: scope.currencies,
      },
    });

    return {
      fabricId,
      colorsDeleted: deletedColors.length,
      rollsDeleted: deletedRolls.length,
      stockMovementsDeleted: deletedMoves.length,
      invoicesDeleted: deletedInvoices.length,
      invoiceLinesDeleted: deletedLines.length + orphanLines.length,
      ledgerEntriesDeleted: deletedLedger.length,
      vouchersDeleted: deletedVouchers.length,
      cashDelta: { syp: round2(after.syp - before.syp), usd: round2(after.usd - before.usd) },
      currenciesRebuilt: scope.currencies,
    };
  } finally {
    // Restored on success, rolled back with the transaction on failure.
    await tx.execute(sql`
      CREATE TRIGGER trg_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()`);
  }
}

export async function dyeExists(tx: Tx, tenantId: string, fabricId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: fabrics.id })
    .from(fabrics)
    .where(and(eq(fabrics.tenantId, tenantId), eq(fabrics.id, fabricId)))
    .limit(1);
  return Boolean(row);
}
