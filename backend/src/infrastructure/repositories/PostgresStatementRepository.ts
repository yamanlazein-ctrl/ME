import { eq, and, gte, lte, sql, inArray, asc, getTableColumns } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DB } from "../orm/drizzle.js";
import type {
  IStatementRepository,
  SettlePartyInput,
} from "../../application/ports/IStatementRepository.js";
import type {
  PartyStatementData,
  StatementDocumentInfo,
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
import { vouchers } from "../orm/schemas/voucher.table.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import { round2dp } from "@erp/shared";
import { BusinessRuleError } from "../../domain/errors/index.js";
import { customerCreditPosition } from "./customerCredit.js";

import { localToday } from "../utils/localDate.js";
const INVOICE_TYPES = ["sales_invoice", "purchase_invoice"];
const VOUCHER_REF_TYPES = ["receipt_in", "payment_out"];

const TYPE_LABEL: Record<string, string> = {
  opening: "الرصيد الافتتاحي",
  purchase_invoice: "فاتورة شراء",
  sales_invoice: "فاتورة بيع",
  payment_out: "سند دفع",
  receipt_in: "سند قبض",
  settlement_discount_expense: "خصم على قبض",
  settlement_discount_income: "خصم على صرف",
  purchase_return: "مرتجع شراء",
  sales_return: "مرتجع بيع",
  sales_return_contra: "عكس إيراد مرتجع بيع",
  purchase_return_contra: "عكس مرتجع شراء",
  expense: "مصروف",
  printing_charge: "أجور طباعة",
  adjustment: "تعديل",
  settlement: "تسوية حساب",
  cancellation: "إلغاء",
  fx_gain: "ربح فرق عملة",
  fx_loss: "خسارة فرق عملة",
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

    // Window filters (full register for totals; page may be a slice).
    // Cancelled rows stay in the register; balances/totals exclude them.
    const winConditions = [
      eq(ledgerEntries.partyId, query.partyId),
      eq(ledgerEntries.tenantId, ctx.tenantId),
    ];
    if (!allCurrencies) winConditions.push(eq(ledgerEntries.currency, currency));
    if (fromDate) winConditions.push(gte(ledgerEntries.date, fromDate));
    if (toDate) winConditions.push(lte(ledgerEntries.date, toDate));
    if (type) winConditions.push(eq(ledgerEntries.type, type));

    const STATEMENT_DEFAULT_LIMIT = 200;
    const STATEMENT_MAX_LIMIT = 500;
    const requestedLimit = query.limit;
    const pageLimit = Math.min(
      STATEMENT_MAX_LIMIT,
      Math.max(1, requestedLimit ?? STATEMENT_DEFAULT_LIMIT),
    );
    // Legacy callers that omit limit still get a hard cap (never unbounded).
    const hardCap = requestedLimit == null;

    type Cursor = { date: string; createdAt: string; id: string };
    const parseCursor = (raw?: string): Cursor | null => {
      if (!raw) return null;
      const parts = raw.split("|");
      if (parts.length !== 3) return null;
      return { date: parts[0]!, createdAt: parts[1]!, id: parts[2]! };
    };
    const cursor = parseCursor(query.cursor);

    const pageConditions = [...winConditions];
    if (cursor) {
      pageConditions.push(
        sql`(
          ${ledgerEntries.date} > ${cursor.date}
          OR (${ledgerEntries.date} = ${cursor.date} AND ${ledgerEntries.createdAt} > ${cursor.createdAt}::timestamptz)
          OR (${ledgerEntries.date} = ${cursor.date} AND ${ledgerEntries.createdAt} = ${cursor.createdAt}::timestamptz AND ${ledgerEntries.id} > ${cursor.id}::uuid)
        )`,
      );
    }

    // Active totals for the FULL window (independent of page).
    const totalRows = await this.db
      .select({
        currency: ledgerEntries.currency,
        debit: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.status} = 'active' THEN ${ledgerEntries.debit} ELSE 0 END), 0)`,
        credit: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.status} = 'active' THEN ${ledgerEntries.credit} ELSE 0 END), 0)`,
      })
      .from(ledgerEntries)
      .where(and(...winConditions))
      .groupBy(ledgerEntries.currency);

    const debitByCurrency = new Map<string, number>();
    const creditByCurrency = new Map<string, number>();
    const runningByCurrency = new Map<string, number>(prevByCurrency);
    for (const row of totalRows) {
      const d = Number(row.debit ?? 0);
      const c = Number(row.credit ?? 0);
      debitByCurrency.set(row.currency, d);
      creditByCurrency.set(row.currency, c);
      const prev = prevByCurrency.get(row.currency) ?? 0;
      runningByCurrency.set(row.currency, round2dp(prev + mult * (d - c)));
    }

    // Numbered-page mode: OFFSET inside ONE party's window (index-backed and
    // bounded by that party's own row count), with the carried balance summed
    // over exactly the rows that precede the page in the same total order.
    const pageNo = !cursor && query.page != null ? Math.max(0, Math.floor(query.page)) : null;
    const pageOffset = pageNo != null ? pageNo * pageLimit : 0;
    let totalRowsInWindow: number | null = null;
    if (pageNo != null) {
      const [cnt] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(and(...winConditions));
      totalRowsInWindow = Number(cnt?.n ?? 0);
    }

    // Balance immediately before this page (for runningBalance continuity).
    const beforePageByCurrency = new Map<string, number>(prevByCurrency);
    if (pageNo != null && pageOffset > 0) {
      const head = this.db
        .select({
          currency: ledgerEntries.currency,
          debit: ledgerEntries.debit,
          credit: ledgerEntries.credit,
          status: ledgerEntries.status,
        })
        .from(ledgerEntries)
        .where(and(...winConditions))
        .orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
        .limit(pageOffset)
        .as("head");
      const headRows = await this.db
        .select({
          currency: head.currency,
          debit: sql<number>`COALESCE(SUM(CASE WHEN ${head.status} = 'active' THEN ${head.debit} ELSE 0 END), 0)`,
          credit: sql<number>`COALESCE(SUM(CASE WHEN ${head.status} = 'active' THEN ${head.credit} ELSE 0 END), 0)`,
        })
        .from(head)
        .groupBy(head.currency);
      for (const row of headRows) {
        const prev = prevByCurrency.get(row.currency) ?? 0;
        beforePageByCurrency.set(
          row.currency,
          round2dp(prev + mult * (Number(row.debit ?? 0) - Number(row.credit ?? 0))),
        );
      }
    }
    if (cursor) {
      const beforeConds = [
        ...winConditions,
        sql`(
          ${ledgerEntries.date} < ${cursor.date}
          OR (${ledgerEntries.date} = ${cursor.date} AND ${ledgerEntries.createdAt} < ${cursor.createdAt}::timestamptz)
          OR (${ledgerEntries.date} = ${cursor.date} AND ${ledgerEntries.createdAt} = ${cursor.createdAt}::timestamptz AND ${ledgerEntries.id} <= ${cursor.id}::uuid)
        )`,
      ];
      const beforeRows = await this.db
        .select({
          currency: ledgerEntries.currency,
          debit: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.status} = 'active' THEN ${ledgerEntries.debit} ELSE 0 END), 0)`,
          credit: sql<number>`COALESCE(SUM(CASE WHEN ${ledgerEntries.status} = 'active' THEN ${ledgerEntries.credit} ELSE 0 END), 0)`,
        })
        .from(ledgerEntries)
        .where(and(...beforeConds))
        .groupBy(ledgerEntries.currency);
      for (const row of beforeRows) {
        const prev = prevByCurrency.get(row.currency) ?? 0;
        beforePageByCurrency.set(
          row.currency,
          round2dp(prev + mult * (Number(row.debit ?? 0) - Number(row.credit ?? 0))),
        );
      }
    }

    const fetchLimit = pageLimit + 1;
    // createdAtUs: full microsecond precision for the cursor. A JS Date keeps
    // only milliseconds, so `created_at > cursor` matched the boundary row
    // again and every page repeated the previous page's last row(s) — found by
    // the 5-year audit (11 duplicated rows in a 4,022-row statement).
    const window = await this.db
      .select({
        ...getTableColumns(ledgerEntries),
        createdAtUs: sql<string>`to_char(${ledgerEntries.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(ledgerEntries)
      .where(and(...pageConditions))
      .orderBy(asc(ledgerEntries.date), asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
      .limit(fetchLimit)
      .offset(pageOffset);

    const hasMore = window.length > pageLimit;
    const pageRows = hasMore ? window.slice(0, pageLimit) : window;

    const invoiceEntries = pageRows.filter((r) => INVOICE_TYPES.includes(r.type) && r.referenceId);
    const linesByInvoice = await this.loadLineDetails(
      invoiceEntries.map((r) => r.referenceId as string),
      ctx,
    );

    const documentsByRef = await this.loadDocuments(pageRows, ctx);

    const pageRunning = new Map<string, number>(beforePageByCurrency);
    const entries: StatementEntryData[] = pageRows.map((row, i) => {
      const debit = Number(row.debit ?? 0);
      const credit = Number(row.credit ?? 0);
      const rowCcy = row.currency ?? currency;
      const isCancelled = row.status !== "active";
      const margin = mult * (debit - credit);
      let running = pageRunning.get(rowCcy) ?? 0;
      if (!isCancelled) {
        running += margin;
        pageRunning.set(rowCcy, running);
      }

      const entry: StatementEntryData = {
        id: row.id,
        seq: pageOffset + i + 1,
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

      const doc = row.referenceId ? documentsByRef.get(`${row.type}:${row.referenceId}`) : undefined;
      if (doc) {
        entry.document =
          doc.info.kind === "voucher"
            ? { ...doc.info, crossCurrency: doc.info.currency !== rowCcy }
            : doc.info;
      }

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

    void hardCap; // hard cap always applied via pageLimit default

    const totalsByCurrency: NonNullable<PartyStatementData["totalsByCurrency"]> = {};
    const allCcys = new Set<string>([
      ...prevByCurrency.keys(),
      ...runningByCurrency.keys(),
      ...debitByCurrency.keys(),
      ...creditByCurrency.keys(),
    ]);
    if (!allCurrencies) allCcys.add(currency);
    for (const ccy of allCcys) {
      const finalBalance = round2dp(runningByCurrency.get(ccy) ?? prevByCurrency.get(ccy) ?? 0);
      const side: "debit" | "credit" | "zero" =
        Math.abs(finalBalance) < 0.01
          ? "zero"
          : (finalBalance > 0) === (p.kind === "customer")
            ? "debit"
            : "credit";
      totalsByCurrency[ccy] = {
        previousBalance: round2dp(prevByCurrency.get(ccy) ?? 0),
        totalDebit: round2dp(debitByCurrency.get(ccy) ?? 0),
        totalCredit: round2dp(creditByCurrency.get(ccy) ?? 0),
        finalBalance,
        balanceSide: side,
        ...(p.kind === "customer"
          ? {
              availableCredit: (
                await customerCreditPosition(this.db, ctx.tenantId, query.partyId, ccy)
              ).availableCredit,
            }
          : {}),
      };
    }

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

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? `${last.date}|${last.createdAtUs}|${last.id}`
        : null;

    const primaryBefore =
      !allCurrencies
        ? round2dp(beforePageByCurrency.get(currency) ?? prevByCurrency.get(currency) ?? 0)
        : 0;

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
      page: {
        limit: pageLimit,
        hasMore,
        nextCursor,
        balanceBeforePage: primaryBefore,
        balanceBeforePageByCurrency: Object.fromEntries(
          [...new Set([...beforePageByCurrency.keys(), ...(allCurrencies ? [] : [currency])])].map((c) => [
            c,
            round2dp(beforePageByCurrency.get(c) ?? 0),
          ]),
        ),
        ...(pageNo != null
          ? {
              page: pageNo,
              totalRows: totalRowsInWindow ?? 0,
              totalPages: Math.max(1, Math.ceil((totalRowsInWindow ?? 0) / pageLimit)),
            }
          : {}),
      },
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
      if (net === 0) throw new BusinessRuleError("الرصيد صفر لا يحتاج تسوية");
      const amount = Math.abs(net);

      // H-NEW (forensic audit 2026-08-25): the SET reference number is
      // allocated INSIDE this transaction (after the zero-balance guard), so
      // a rejected settlement never burns a sequence slot. Explicit caller
      // references still pass through untouched.
      const referenceNumber =
        input.referenceNumber ??
        (await allocateDocumentNumber(tx, "settlement", ctx.tenantId, {
          syncDeviceId: ctx.syncDeviceId,
        }));

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
            date: input.date ?? localToday(),
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
            date: input.date ?? localToday(),
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

  /**
   * Original documents behind the party-leg rows of the window: the invoice
   * (own currency + frozen historical rate) for invoice rows, and the voucher
   * (payment currency, amount, rate captured at payment time, the invoice it
   * was applied to) for receipt/payment rows. Keyed `${ledgerType}:${referenceId}`.
   */
  private async loadDocuments(
    window: LedgerRow[],
    ctx: TenantContext,
  ): Promise<Map<string, { info: StatementDocumentInfo }>> {
    const out = new Map<string, { info: StatementDocumentInfo }>();

    const invoiceIds = [
      ...new Set(
        window
          .filter((r) => INVOICE_TYPES.includes(r.type) && r.referenceId)
          .map((r) => r.referenceId as string),
      ),
    ];
    if (invoiceIds.length > 0) {
      const rows = await this.db
        .select({
          id: invoices.id,
          number: invoices.number,
          currency: invoices.currency,
          exchangeRate: invoices.exchangeRate,
          total: invoices.total,
          paid: invoices.paid,
          creditApplied: invoices.creditApplied,
        })
        .from(invoices)
        .where(and(inArray(invoices.id, invoiceIds), eq(invoices.tenantId, ctx.tenantId)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const r of window) {
        if (!INVOICE_TYPES.includes(r.type) || !r.referenceId) continue;
        const inv = byId.get(r.referenceId);
        if (!inv) continue;
        out.set(`${r.type}:${r.referenceId}`, {
          info: {
            kind: "invoice",
            number: inv.number,
            currency: inv.currency ?? r.currency,
            amount: round2dp(Number(inv.total)),
            exchangeRate: inv.exchangeRate != null ? Number(inv.exchangeRate) : null,
            paid: round2dp(Number(inv.paid ?? 0)),
            ...(Number(inv.creditApplied ?? 0) > 0
              ? { creditApplied: round2dp(Number(inv.creditApplied)) }
              : {}),
          },
        });
      }
    }

    const voucherIds = [
      ...new Set(
        window
          .filter((r) => VOUCHER_REF_TYPES.includes(r.type) && r.referenceId)
          .map((r) => r.referenceId as string),
      ),
    ];
    if (voucherIds.length > 0) {
      const rows = await this.db
        .select({
          id: vouchers.id,
          number: vouchers.number,
          currency: vouchers.currency,
          exchangeRate: vouchers.exchangeRate,
          amount: vouchers.amount,
          discount: vouchers.discount,
          method: vouchers.method,
          invoiceId: vouchers.invoiceId,
          appliedAmount: vouchers.appliedAmount,
          invoiceNumber: invoices.number,
          invoiceCurrency: invoices.currency,
        })
        .from(vouchers)
        .leftJoin(invoices, eq(vouchers.invoiceId, invoices.id))
        .where(and(inArray(vouchers.id, voucherIds), eq(vouchers.tenantId, ctx.tenantId)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const r of window) {
        if (!VOUCHER_REF_TYPES.includes(r.type) || !r.referenceId) continue;
        const v = byId.get(r.referenceId);
        if (!v) continue;
        const rate = v.exchangeRate != null ? Number(v.exchangeRate) : null;
        // Customer receipts: the part that did NOT settle an invoice is an
        // advance (credit balance). The party leg (this row) is the full amount
        // in the row's currency; a linked receipt applied only `appliedAmount`.
        let advanceAmount: number | undefined;
        if (r.type === "receipt_in") {
          const partyLeg = Number(r.credit ?? 0);
          const excess = !v.invoiceId
            ? partyLeg
            : v.appliedAmount != null
              ? round2dp(partyLeg - Number(v.appliedAmount))
              : 0;
          if (excess > 0.01) advanceAmount = round2dp(excess);
        }
        out.set(`${r.type}:${r.referenceId}`, {
          info: {
            kind: "voucher",
            number: v.number,
            currency: v.currency,
            amount: round2dp(Number(v.amount)),
            exchangeRate: rate != null && rate > 0 ? rate : null,
            discount: round2dp(Number(v.discount ?? 0)),
            method: v.method,
            ...(advanceAmount !== undefined ? { advanceAmount } : {}),
            ...(v.invoiceNumber
              ? {
                  appliedToInvoiceNumber: v.invoiceNumber,
                  appliedToInvoiceCurrency: v.invoiceCurrency ?? undefined,
                }
              : {}),
          },
        });
      }
    }
    return out;
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
