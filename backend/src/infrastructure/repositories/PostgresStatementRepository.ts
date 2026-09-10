import { eq, and, gte, lte, sql, inArray, asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../orm/drizzle.js";
import type {
  IStatementRepository,
  SettlePartyInput,
} from "../../application/ports/IStatementRepository.js";
import type {
  PartyStatementData,
  StatementEntryData,
  StatementLineDetail,
  StatementQuery,
} from "../../domain/entities/Statement.js";
import type { LedgerEntryData } from "../../domain/entities/LedgerEntry.js";
import type { TenantContext, UUID } from "../../domain/types/index.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { parties } from "../orm/schemas/party.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { fabrics } from "../orm/schemas/fabric.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import { round2dp } from "@erp/shared";

const INVOICE_TYPES = ["sales_invoice", "purchase_invoice"];

const TYPE_LABEL: Record<string, string> = {
  opening: "الرصيد الافتتاحي",
  purchase_invoice: "فاتورة شراء",
  sales_invoice: "فاتورة بيع",
  payment_out: "سند دفع",
  receipt_in: "سند قبض",
  purchase_return: "مرتجع شراء",
  sales_return: "مرتجع بيع",
  sales_return_contra: "عكس إيراد مرتجع بيع",
  purchase_return_contra: "عكس مرتجع شراء",
  expense: "مصروف",
  printing_charge: "أجور طباعة",
  adjustment: "تعديل",
  settlement: "تسوية حساب",
  cancellation: "إلغاء",
};

type LedgerRow = typeof ledgerEntries.$inferSelect;

export class PostgresStatementRepository implements IStatementRepository {
  constructor(private readonly db: DB) {}

  async getStatement(query: StatementQuery, ctx: TenantContext): Promise<PartyStatementData> {
    const party = await this.db
      .select()
      .from(parties)
      .where(and(eq(parties.id, query.partyId), eq(parties.tenantId, ctx.tenantId)))
      .limit(1);
    if (party.length === 0) throw new Error("الطرف غير موجود");
    const p = party[0];
    if (p.kind !== query.kind) {
      throw new Error(p.kind === "customer" ? "الطرف ليس عميلاً" : "الطرف ليس مورداً");
    }
    const allCurrencies = query.currency === "ALL" || query.currency === "all";
    const currency = allCurrencies ? "ALL" : (query.currency ?? p.currency ?? "SYP");
    const fromDate = query.fromDate ?? null;
    const toDate = query.toDate ?? null;
    const type = query.type ?? null;

    // Standard double-entry sign convention (Dr AR for customers, Cr AP for
    // suppliers): customer balance = debit − credit, supplier balance =
    // credit − debit. This matches the ledger writers (purchase invoice →
    // Cr party, purchase return / supplier payment → Dr party) and
    // PostgresLedgerRepository.getBalance()/getBalanceByDate().
    const mult = p.kind === "customer" ? 1 : -1;

    // previous balance = signed sum of active movements strictly before `from`
    // (no `from` → nothing is "before", so previous balance is 0)
    const prevByCurrency = new Map<string, number>();
    if (fromDate) {
      // The previous balance must respect the same logical filters as the
      // visible window (especially `type`), otherwise the running/final balance
      // diverges from the displayed entries when filtering by type + date.
      const prevConditions = [
        eq(ledgerEntries.partyId, query.partyId),
        eq(ledgerEntries.tenantId, ctx.tenantId),
        eq(ledgerEntries.status, "active"),
        sql`${ledgerEntries.date} < ${fromDate}`,
      ];
      if (!allCurrencies) prevConditions.push(eq(ledgerEntries.currency, currency));
      if (type) prevConditions.push(eq(ledgerEntries.type, type));

      const prevRows = await this.db
        .select({
          currency: ledgerEntries.currency,
          debit: sql<number>`COALESCE(SUM(${ledgerEntries.debit}), 0)`,
          credit: sql<number>`COALESCE(SUM(${ledgerEntries.credit}), 0)`,
        })
        .from(ledgerEntries)
        .where(and(...prevConditions))
        .groupBy(ledgerEntries.currency);
      for (const row of prevRows) {
        const prevRaw = Number(row.debit ?? 0) - Number(row.credit ?? 0);
        prevByCurrency.set(row.currency, mult * prevRaw);
      }
    }

    // statement window = ALL rows within [from, to] (chronological).
    // Cancelled rows are kept in the register (never dropped from the query)
    // so the statement shows the full history; they are struck through by the
    // UI and excluded from balances/totals below.
    const winConditions = [
      eq(ledgerEntries.partyId, query.partyId),
      eq(ledgerEntries.tenantId, ctx.tenantId),
    ];
    if (!allCurrencies) winConditions.push(eq(ledgerEntries.currency, currency));
    if (fromDate) winConditions.push(gte(ledgerEntries.date, fromDate));
    if (toDate) winConditions.push(lte(ledgerEntries.date, toDate));
    if (type) winConditions.push(eq(ledgerEntries.type, type));

    const window = await this.db
      .select()
      .from(ledgerEntries)
      .where(and(...winConditions))
      .orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt));

    // line details for invoice rows (sales_invoice / purchase_invoice)
    const invoiceEntries = window.filter((r) => INVOICE_TYPES.includes(r.type) && r.referenceId);
    const linesByInvoice = await this.loadLineDetails(
      invoiceEntries.map((r) => r.referenceId as string),
      ctx,
    );

    const runningByCurrency = new Map<string, number>(prevByCurrency);
    const debitByCurrency = new Map<string, number>();
    const creditByCurrency = new Map<string, number>();

    const entries: StatementEntryData[] = window.map((row, i) => {
      const debit = Number(row.debit ?? 0);
      const credit = Number(row.credit ?? 0);
      const rowCcy = row.currency ?? currency;
      const isCancelled = row.status !== "active";
      // Cancelled movements are displayed but do NOT move the account: skip
      // their margin so runningBalance/totals only reflect active movements
      // (matches the balance semantics used across the rest of the system).
      const margin = mult * (debit - credit);
      let running = runningByCurrency.get(rowCcy) ?? 0;
      if (!isCancelled) {
        running += margin;
        runningByCurrency.set(rowCcy, running);
        debitByCurrency.set(rowCcy, (debitByCurrency.get(rowCcy) ?? 0) + debit);
        creditByCurrency.set(rowCcy, (creditByCurrency.get(rowCcy) ?? 0) + credit);
      }

      const entry: StatementEntryData = {
        id: row.id,
        seq: i + 1,
        date: row.date,
        type: row.type as StatementEntryData["type"],
        status: isCancelled ? "cancelled" : "active",
        currency: rowCcy,
        referenceType: row.referenceType ?? undefined,
        referenceId: row.referenceId ?? undefined,
        referenceNumber: row.referenceNumber ?? undefined,
        description:
          row.description ??
          (row.referenceNumber
            ? `${TYPE_LABEL[row.type] ?? row.type} ${row.referenceNumber}`
            : (TYPE_LABEL[row.type] ?? row.type)),
        debit: round2dp(debit),
        credit: round2dp(credit),
        runningBalance: round2dp(running),
      };

      if (INVOICE_TYPES.includes(row.type) && row.referenceId) {
        const lines = linesByInvoice.get(row.referenceId) ?? [];
        if (lines.length > 0) {
          const qty = lines.reduce((s, l) => s + l.quantityKg, 0);
          const amount = debit > 0 ? debit : lines.reduce((s, l) => s + l.amount, 0);
          entry.quantityKg = Math.round(qty * 100) / 100;
          entry.pricePerKg = qty > 0 ? Math.round((amount / qty) * 100) / 100 : 0;
          entry.lines = lines;
        }
      }

      return entry;
    });

    const totalsByCurrency: NonNullable<PartyStatementData["totalsByCurrency"]> = {};
    const allCcys = new Set<string>([
      ...prevByCurrency.keys(),
      ...runningByCurrency.keys(),
      ...debitByCurrency.keys(),
      ...creditByCurrency.keys(),
    ]);
    if (!allCurrencies) allCcys.add(currency);
    for (const ccy of allCcys) {
      totalsByCurrency[ccy] = {
        previousBalance: round2dp(prevByCurrency.get(ccy) ?? 0),
        totalDebit: round2dp(debitByCurrency.get(ccy) ?? 0),
        totalCredit: round2dp(creditByCurrency.get(ccy) ?? 0),
        finalBalance: round2dp(runningByCurrency.get(ccy) ?? prevByCurrency.get(ccy) ?? 0),
      };
    }

    // Single-currency response keeps the classic scalar totals. Multi-currency
    // zeros the scalars (mixing SYP+USD would lie) and exposes totalsByCurrency.
    const primary = allCurrencies
      ? {
          previousBalance: 0,
          totalDebit: 0,
          totalCredit: 0,
          finalBalance: 0,
        }
      : (totalsByCurrency[currency] ?? {
          previousBalance: 0,
          totalDebit: 0,
          totalCredit: 0,
          finalBalance: 0,
        });

    return {
      partyId: query.partyId,
      partyName: p.name,
      partyCode: p.code ?? null,
      kind: query.kind,
      currency,
      fromDate,
      toDate,
      type,
      previousBalance: primary.previousBalance,
      totalDebit: primary.totalDebit,
      totalCredit: primary.totalCredit,
      finalBalance: primary.finalBalance,
      totalsByCurrency,
      entries,
    };
  }

  async settle(
    partyId: UUID,
    input: SettlePartyInput,
    ctx: TenantContext,
  ): Promise<LedgerEntryData> {
    // Fix C-5 (forensic audit 2026-08-15, live-reproduced): this used to be
    // a bare SELECT (aggregate balance) followed by a bare INSERT, both on
    // the connection pool — no transaction, no lock. Two concurrent (or
    // simply retried) settle() calls both read the same pre-settlement
    // `net`, both post a settlement of the full amount, and the party ends
    // up settled twice — the balance lands at -net instead of 0.
    //
    // Fix: run the balance read and the insert inside one transaction,
    // holding a row lock on the party (`FOR UPDATE`) for its whole
    // duration. This serializes concurrent settle() calls for the SAME
    // party: the second call blocks until the first commits, then
    // re-aggregates the balance itself — which now correctly includes the
    // first call's just-inserted settlement rows, since they are ordinary
    // active ledger entries for this party. A genuinely zero balance after
    // the first settlement makes the second call hit the existing
    // "لا يحتاج تسوية" guard instead of posting a second settlement — the
    // fix requires no new idempotency key, only making the read-then-write
    // atomic and serialized against itself.
    return this.db.transaction(async (tx) => {
      const party = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (party.length === 0) throw new Error("الطرف غير موجود");
      const currency = input.currency ?? party[0].currency ?? "SYP";

      const rows = await tx
        .select({
          debit: sql<number>`COALESCE(SUM(${ledgerEntries.debit}), 0)`,
          credit: sql<number>`COALESCE(SUM(${ledgerEntries.credit}), 0)`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.partyId, partyId),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.status, "active"),
            eq(ledgerEntries.currency, currency),
          ),
        );

      const net = Number(rows[0]?.debit ?? 0) - Number(rows[0]?.credit ?? 0);
      if (net === 0) throw new Error("الرصيد صفر لا يحتاج تسوية");
      const amount = Math.abs(net);

      // H-NEW (forensic audit 2026-08-25): the SET reference number is
      // allocated INSIDE this transaction (after the zero-balance guard), so
      // a rejected settlement never burns a sequence slot. Explicit caller
      // references still pass through untouched.
      const referenceNumber =
        input.referenceNumber ??
        (await allocateDocumentNumber(tx, "settlement", ctx.tenantId));

      // M8: both settlement legs share a real generated UUID as referenceId so
      // the pair is resolvable/reversible by reference (cancel-by-reference),
      // instead of a NULL that orphans them from every document lookup.
      const settlementRefId = randomUUID();

      const inserted = await tx
        .insert(ledgerEntries)
        .values([
          {
            tenantId: ctx.tenantId,
            partyId,
            date: input.date ?? new Date().toISOString().slice(0, 10),
            type: "settlement",
            debit: net < 0 ? amount : 0,
            credit: net > 0 ? amount : 0,
            currency,
            cashImpact: "none",
            referenceType: "settlement",
            referenceId: settlementRefId,
            referenceNumber,
            description: input.notesInternal ?? `تسوية حساب ${referenceNumber}`,
            createdBy: ctx.userId,
          },
          {
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date ?? new Date().toISOString().slice(0, 10),
            type: "settlement_contra",
            debit: net > 0 ? amount : 0,
            credit: net < 0 ? amount : 0,
            currency,
            cashImpact: "none",
            referenceType: "settlement",
            referenceId: settlementRefId,
            referenceNumber,
            description: `مقابل التسوية ${referenceNumber}`,
            createdBy: ctx.userId,
          },
        ])
        .returning();

      return this.mapEntry(inserted[0]);
    });
  }

  /** Load invoice line details (fabric/color/roll + qty/price) for the given invoices. */
  private async loadLineDetails(
    invoiceIds: string[],
    ctx: TenantContext,
  ): Promise<Map<string, StatementLineDetail[]>> {
    const map = new Map<string, StatementLineDetail[]>();
    if (invoiceIds.length === 0) return map;

    const rows = await this.db
      .select({
        invoiceId: invoiceLines.invoiceId,
        fabricId: invoiceLines.fabricId,
        fabricName: fabrics.name,
        colorId: invoiceLines.colorId,
        colorName: colors.name,
        rollId: invoiceLines.rollId,
        rollNo: rolls.rollNo,
        quantityKg: invoiceLines.quantityKg,
        pricePerKg: invoiceLines.pricePerKg,
      })
      .from(invoiceLines)
      .innerJoin(fabrics, eq(fabrics.id, invoiceLines.fabricId))
      .innerJoin(colors, eq(colors.id, invoiceLines.colorId))
      .innerJoin(rolls, eq(rolls.id, invoiceLines.rollId))
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(inArray(invoiceLines.invoiceId, invoiceIds), eq(invoices.tenantId, ctx.tenantId)));

    for (const r of rows) {
      const qty = Number(r.quantityKg ?? 0);
      const price = Number(r.pricePerKg ?? 0);
      const line: StatementLineDetail = {
        fabricId: r.fabricId,
        fabricName: r.fabricName,
        colorId: r.colorId,
        colorName: r.colorName,
        rollId: r.rollId,
        rollNo: r.rollNo ?? null,
        quantityKg: Math.round(qty * 100) / 100,
        pricePerKg: Math.round(price * 100) / 100,
        amount: round2dp(qty * price),
      };
      const list = map.get(r.invoiceId) ?? [];
      list.push(line);
      map.set(r.invoiceId, list);
    }
    return map;
  }

  private mapEntry(row: LedgerRow): LedgerEntryData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      partyId: row.partyId,
      date: row.date,
      type: row.type as LedgerEntryData["type"],
      debit: Number(row.debit ?? 0),
      credit: Number(row.credit ?? 0),
      currency: row.currency,
      cashImpact: row.cashImpact as LedgerEntryData["cashImpact"],
      referenceType: n(row.referenceType),
      referenceId: n(row.referenceId),
      referenceNumber: n(row.referenceNumber),
      description: n(row.description),
      status: row.status as LedgerEntryData["status"],
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
      cancellationReferenceId: n(row.cancellationReferenceId),
    };
  }
}
