import { eq, and, desc, ilike, or, sql, gte, lte } from "drizzle-orm";
import { BusinessRuleError } from "../../domain/errors/index.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import type { DB } from "../orm/drizzle.js";
import type {
  IVoucherRepository,
  VoucherFilter,
} from "../../application/ports/IVoucherRepository.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { assertDayUnlocked } from "./dayLockHelper.js";
import {
  Voucher,
  type VoucherData,
  type CreateVoucherInput,
} from "../../domain/entities/Voucher.js";
import {
  BASE_CURRENCY,
  computeBaseEquivalent,
  convertForSettlement,
  fromBaseEquivalent,
  isValidFxRate,
  round2dp,
  FX_REQUIRED_MESSAGE,
  type FxSide,
} from "@erp/shared";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresVoucherRepository implements IVoucherRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<VoucherData | null> {
    const rows = await this.db
      .select({
        voucher: vouchers,
        invoiceCurrency: invoices.currency,
        invoiceExchangeRate: invoices.exchangeRate,
      })
      .from(vouchers)
      .leftJoin(invoices, eq(vouchers.invoiceId, invoices.id))
      .where(and(eq(vouchers.id, id), eq(vouchers.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0].voucher, {
      currency: rows[0].invoiceCurrency,
      exchangeRate: rows[0].invoiceExchangeRate,
    });
  }

  async list(filter: VoucherFilter, ctx: TenantContext): Promise<PaginatedResult<VoucherData>> {
    const conditions = [eq(vouchers.tenantId, ctx.tenantId)];
    if (filter.kind) conditions.push(eq(vouchers.kind, filter.kind));
    if (filter.partyId) conditions.push(eq(vouchers.partyId, filter.partyId));
    if (filter.invoiceId) conditions.push(eq(vouchers.invoiceId, filter.invoiceId));
    if (filter.status) conditions.push(eq(vouchers.status, filter.status));
    if (filter.fromDate) conditions.push(gte(vouchers.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(vouchers.date, filter.toDate));
    if (filter.search) conditions.push(or(ilike(vouchers.number!, `%${filter.search}%`))!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({
          voucher: vouchers,
          invoiceCurrency: invoices.currency,
          invoiceExchangeRate: invoices.exchangeRate,
        })
        .from(vouchers)
        // Carries the linked invoice's currency + frozen rate so the print
        // template can render the cross-currency counterpart line. The COUNT
        // query stays on vouchers alone — a join would not change the total.
        .leftJoin(invoices, eq(vouchers.invoiceId, invoices.id))
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(vouchers.date), desc(vouchers.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(vouchers)
        .where(where),
    ]);

    return {
      data: dataRows.map((r) =>
        this.toDomain(r.voucher, {
          currency: r.invoiceCurrency,
          exchangeRate: r.invoiceExchangeRate,
        }),
      ),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(
    input: CreateVoucherInput,
    ctx: TenantContext,
  ): Promise<VoucherData> {
    return this.db.transaction(async (tx) => {
      await assertDayUnlocked(tx, ctx.tenantId, input.date);
      // H-NEW (forensic audit 2026-08-25, voucher numbering): allocate the
      // document number INSIDE this transaction so a failure in the guards
      // below (over-collection, cross-currency, cancelled-invoice, FK) does
      // not burn a number. Allocation also stays atomic with the ledger
      // double-entry inserts and the invoices.paid update, so a crash
      // mid-insert rolls back the entire voucher including its number.
      const autoNumber = await allocateDocumentNumber(tx, "voucher", ctx.tenantId, {
        syncDeviceId: ctx.syncDeviceId,
        preAllocatedNumber: input.preAllocatedNumber,
      });

      // FX capture (base currency = USD, fx.ts rule). A non-USD voucher without a
      // valid rate fails closed so the ledger base-equivalent stays convertible and
      // balanced — mirroring the invoice repository's create/update guard. USD is 1.
      // Resolved BEFORE the invoice guards because settling an invoice in another
      // currency needs the voucher's own rate to convert with.
      const voucherCurrency = input.currency ?? "SYP";
      const fxRate =
        voucherCurrency === BASE_CURRENCY
          ? 1
          : isValidFxRate(input.exchangeRate)
            ? input.exchangeRate!
            : null;
      if (voucherCurrency !== BASE_CURRENCY && !isValidFxRate(fxRate)) {
        throw new BusinessRuleError(FX_REQUIRED_MESSAGE);
      }
      const voucherFx: FxSide = { currency: voucherCurrency, exchangeRate: fxRate };

      // What this voucher actually settles on the linked invoice, restated in the
      // INVOICE's currency. Stays null for a standalone payment (no invoice).
      let settledInInvoiceCurrency: number | null = null;
      // Currency + frozen rate of the invoice we just locked, echoed back on the
      // created voucher so the caller can print the counterpart immediately.
      let linkedInvoiceFx: { currency?: string | null; exchangeRate?: number | null } | undefined;

      if (input.invoiceId) {
        // TX7 fix: lock the invoice row so concurrent voucher inserts serialize
        // and the remaining = total − active_vouchers − returns computation sees
        // committed values. Without this lock, two concurrent transactions read
        // the same voucher sum snapshot and both pass the guard, allowing
        // over-collection.
        const [inv] = await tx
          .select({
            total: invoices.total,
            paid: invoices.paid,
            status: invoices.status,
            currency: invoices.currency,
            exchangeRate: invoices.exchangeRate,
          })
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        if (!inv) throw new BusinessRuleError("الفاتورة المرتبطة غير موجودة");
        // TX5 fix: refuse vouchers against cancelled invoices so the user
        // can't collect on a cancelled document (silent data corruption).
        if (inv.status === "cancelled") {
          throw new BusinessRuleError("لا يمكن إنشاء سند لفاتورة مُلغاة");
        }

        // Cross-currency settlement is ALLOWED — that is what the frozen FX
        // columns exist for. What is never allowed is settling without the rates
        // required to restate both sides in one currency: summing raw amounts
        // across currencies is exactly what used to corrupt the invoice balance
        // (Bug E2E #7), so the conversion runs BEFORE any sum or comparison.
        //
        // Settlement uses the rate entered ON THIS VOUCHER (`convertForSettlement`),
        // never the invoice's own frozen rate — `convertAmount` (each side through
        // its OWN frozen rate) would silently discard whatever the user just typed
        // whenever the voucher's own currency is USD, and settle against a stale
        // rate instead. That is exactly the "10 USD vs 966.2 SYP compared without
        // real conversion" defect: the manual-rate field was collected, validated
        // as required, then thrown away.
        const invRate = Number(inv.exchangeRate);
        const invoiceFx: FxSide = {
          currency: inv.currency ?? "SYP",
          exchangeRate: Number.isFinite(invRate) && invRate > 0 ? invRate : null,
        };
        linkedInvoiceFx = { currency: invoiceFx.currency, exchangeRate: invoiceFx.exchangeRate };
        settledInInvoiceCurrency = convertForSettlement(
          input.amount,
          voucherCurrency,
          invoiceFx.currency,
          isValidFxRate(input.exchangeRate) ? input.exchangeRate! : null,
        );
        if (settledInInvoiceCurrency === null) {
          throw new BusinessRuleError(
            `لا يمكن تسوية فاتورة بعملة ${invoiceFx.currency} بسند بعملة ${voucherCurrency} — ${FX_REQUIRED_MESSAGE}`,
          );
        }

        // `invoices.paid` is already the authoritative running total — every
        // voucher create/cancel maintains it transactionally (below, and in
        // `cancel()`) using this SAME settlement conversion, so re-deriving it
        // here from a separate per-voucher re-aggregation (as before) could
        // only drift from it, not agree with it more. Reading it directly also
        // keeps this guard consistent with the account statement / aging tabs,
        // which read the exact same column.
        const paidSoFar = Number(inv.paid ?? 0);
        // Active returns against this invoice also reduce the amount owed by the
        // party (a sale return credits the customer, mirroring a receipt).
        // Returns carry their own currency/rate, so they convert the same way.
        const [retAgg] = await tx
          .select({
            baseTotal: sql<number>`COALESCE(SUM(
              CASE
                WHEN ${returns.currency} = ${BASE_CURRENCY} THEN ${returnLines.quantityKg} * ${returnLines.pricePerKg}
                ELSE (${returnLines.quantityKg} * ${returnLines.pricePerKg}) / NULLIF(${returns.exchangeRate}, 0)
              END
            ), 0)`,
          })
          .from(returnLines)
          .innerJoin(returns, eq(returnLines.returnId, returns.id))
          .where(
            and(
              eq(returns.originalInvoiceId, input.invoiceId),
              eq(returns.tenantId, ctx.tenantId),
              eq(returns.status, "active"),
            ),
          );
        const returnsAmount =
          fromBaseEquivalent(
            Number(retAgg?.baseTotal ?? 0),
            invoiceFx.currency,
            invoiceFx.exchangeRate,
          ) ?? 0;
        const remaining = round2dp(Number(inv.total) - paidSoFar - returnsAmount);
        // 0.01 tolerance: the conversion rounds to 2dp once, so a payment that
        // settles the invoice exactly can land a fraction of a cent above it.
        if (settledInInvoiceCurrency > remaining + 0.01) {
          throw new BusinessRuleError(
            `بعد التحويل ${settledInInvoiceCurrency} ${invoiceFx.currency} يتجاوز المتبقي ${remaining} ${invoiceFx.currency}`,
          );
        }
      }
      const voucherBaseAmount = computeBaseEquivalent(input.amount, voucherCurrency, fxRate);
      const legFx = (debit: number, credit: number) => ({
        exchangeRate: fxRate,
        baseDebit: computeBaseEquivalent(debit, voucherCurrency, fxRate),
        baseCredit: computeBaseEquivalent(credit, voucherCurrency, fxRate),
      });

      // The rate to PERSIST on the row: whatever the user manually entered,
      // not the trivial `fxRate=1` substituted above for a USD voucher's own
      // base-equivalent bookkeeping (`voucherBaseAmount`/`legFx` below —
      // correct as is, since a USD amount IS already its own base value
      // regardless of any rate). Storing `fxRate` here for a USD voucher
      // settling a non-USD invoice would silently lose the manually-entered
      // rate the moment the voucher is saved — print and a later cancel()
      // reversal both read this column expecting the real rate.
      const storedExchangeRate = isValidFxRate(input.exchangeRate) ? input.exchangeRate! : fxRate;

      const [row] = await tx
        .insert(vouchers)
        .values({
          ...(input.preAllocatedId ? { id: input.preAllocatedId } : {}),
          tenantId: ctx.tenantId,
          kind: input.kind,
          number: autoNumber,
          date: input.date,
          partyId: input.partyId,
          partyKind: input.partyKind,
          invoiceId: input.invoiceId ?? null,
          amount: input.amount,
          currency: voucherCurrency,
          exchangeRate: storedExchangeRate,
          baseAmount: voucherBaseAmount,
          method: input.method,
          notesPrint: input.notesPrint,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
        })
        .returning();

      // Standard double-entry. Party leg mirrors the cash leg so Σdebit=Σcredit:
      //   receipt_in (customer pays) → Cr party (AR decreases) / Dr cash (received)
      //   payment_out (we pay supplier) → Dr party (AP decreases) / Cr cash (paid out)
      // Supplier balance = credit − debit, so Dr payment reduces what we owe.
      const isPayment = input.kind === "payment";
      const refType = isPayment ? "payment_out" : "receipt_in";
      const cashImpact = input.method === "cash" ? (isPayment ? "out" : "in") : "none";
      // C4 fix: double-entry. Party leg + balancing cash leg (carries
      // cashImpact so the cashbox still reads it).
      await tx.insert(ledgerEntries).values([
        {
          ...legFx(isPayment ? input.amount : 0, isPayment ? 0 : input.amount),
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          date: input.date,
          type: refType,
          debit: isPayment ? input.amount : 0,
          credit: isPayment ? 0 : input.amount,
          currency: voucherCurrency,
          cashImpact: "none",
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "Payment" : "Receipt"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
        {
          ...legFx(isPayment ? 0 : input.amount, isPayment ? input.amount : 0),
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "cash",
          // Cash leg mirrors the party leg so Σdebit=Σcredit within the same
          // currency. cashImpact carries the direction (in for receipt, out
          // for payment) so the cashbox/derived balances remain correct
          // regardless of which raw side the value lands on.
          debit: isPayment ? 0 : input.amount,
          credit: isPayment ? input.amount : 0,
          currency: voucherCurrency,
          cashImpact,
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "Cash paid" : "Cash received"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
      ]);

      // Maintain invoices.paid transactionally so amountDue (total-paid) stays
      // consistent when vouchers are collected or cancelled (fix P0-LOGIC-3).
      // `paid` is denominated in the INVOICE's currency, so a foreign-currency
      // voucher credits its converted value — never its raw amount.
      if (input.invoiceId) {
        await tx
          .update(invoices)
          .set({
            paid: sql`${invoices.paid} + ${settledInInvoiceCurrency ?? input.amount}`,
            updatedAt: new Date(),
          })
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      return this.toDomain(row, linkedInvoiceFx);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<VoucherData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(vouchers)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
          updatedAt: new Date(),
          version: sql`${vouchers.version} + 1`,
        })
        .where(
          and(
            eq(vouchers.id, id),
            eq(vouchers.tenantId, ctx.tenantId),
            eq(vouchers.status, "active"),
          ),
        )
        .returning();
      if (!row) throw new Error("Voucher not found or already cancelled");

      // Reverse the linked ledger entry atomically (mirrors invoice cancel).
      await tx
        .update(ledgerEntries)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
        })
        .where(
          and(
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            or(
              eq(ledgerEntries.referenceType, "payment_out"),
              eq(ledgerEntries.referenceType, "receipt_in"),
            ),
            eq(ledgerEntries.status, "active"),
          ),
        );

      // Reverse the invoice paid counter when a receipt/payment is cancelled.
      // The reversal must undo exactly what create() credited: the voucher's
      // amount restated in the invoice's currency, not the raw amount. Rates are
      // re-read from the invoice row (locked) rather than assumed from creation
      // time, so the rollback stays symmetric with the current invoice state.
      if (row.invoiceId) {
        const [inv] = await tx
          .select({ currency: invoices.currency, exchangeRate: invoices.exchangeRate })
          .from(invoices)
          .where(and(eq(invoices.id, row.invoiceId), eq(invoices.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        const invRate = Number(inv?.exchangeRate);
        const invoiceFx: FxSide = {
          currency: inv?.currency ?? "SYP",
          exchangeRate: Number.isFinite(invRate) && invRate > 0 ? invRate : null,
        };
        // Mirrors create()'s settlement math exactly (`convertForSettlement`,
        // using the voucher's OWN recorded rate) — not `convertAmount`, which
        // would settle/reverse against the invoice's frozen rate instead of the
        // rate this specific voucher was actually entered and credited at.
        // Falling back to the raw amount only when conversion is impossible
        // (both sides non-USD and the voucher has no usable rate) — the same
        // value the legacy code subtracted, so the counter still unwinds
        // instead of sticking.
        const reversed =
          convertForSettlement(
            Number(row.amount),
            row.currency ?? "SYP",
            invoiceFx.currency,
            isValidFxRate(row.exchangeRate) ? Number(row.exchangeRate) : null,
          ) ?? Number(row.amount);
        await tx
          .update(invoices)
          .set({ paid: sql`GREATEST(0, ${invoices.paid} - ${reversed})`, updatedAt: new Date() })
          .where(and(eq(invoices.id, row.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      return this.toDomain(row);
    });
  }

  /** Currency + frozen rate of the linked invoice, when the row was joined to it. */
  private toDomain(
    row: typeof vouchers.$inferSelect,
    invoiceFx?: { currency?: string | null; exchangeRate?: number | null },
  ): VoucherData {
    return Voucher.reconstitute(this.mapRow(row, invoiceFx)).toData();
  }

  private mapRow(
    row: typeof vouchers.$inferSelect,
    invoiceFx?: { currency?: string | null; exchangeRate?: number | null },
  ): VoucherData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind as VoucherData["kind"],
      number: row.number,
      date: row.date,
      partyId: row.partyId,
      partyKind: row.partyKind as VoucherData["partyKind"],
      invoiceId: n(row.invoiceId),
      amount: row.amount,
      currency: row.currency,
      exchangeRate: row.exchangeRate ?? undefined,
      baseAmount: row.baseAmount ?? undefined,
      // Only present when the row was selected alongside its invoice (LEFT JOIN);
      // standalone payments simply leave these undefined.
      invoiceCurrency: invoiceFx?.currency ?? undefined,
      invoiceExchangeRate: invoiceFx?.exchangeRate ?? undefined,
      method: row.method as VoucherData["method"],
      status: row.status as VoucherData["status"],
      notesPrint: n(row.notesPrint),
      notesInternal: n(row.notesInternal),
      attachments: (row.attachments as unknown as unknown[]) ?? [],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      updatedAt: row.updatedAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
    };
  }
}
