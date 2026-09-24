import { eq, and, desc, ilike, or, sql, gte, lte, isNotNull } from "drizzle-orm";
import { likeContains } from "../utils/likeEscape.js";
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
import { assertSufficientCashboxBalance } from "./cashboxBalanceHelper.js";
import {
  assertCreditNotOverdrawn,
  customerCreditPosition,
  splitOverpayment,
} from "./customerCredit.js";
import {
  Voucher,
  type VoucherData,
  type CreateVoucherInput,
} from "../../domain/entities/Voucher.js";
import {
  BASE_CURRENCY,
  computeBaseEquivalent,
  convertForSettlement,
  isValidFxRate,
  round2dp,
  saneSypRateError,
  settleAmountAgainstRemaining,
  settlementFromCashAndDiscount,
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
    if (filter.search) conditions.push(or(ilike(vouchers.number!, likeContains(filter.search)))!);
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
          invoiceNumber: invoices.number,
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
          number: r.invoiceNumber,
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

  async create(input: CreateVoucherInput, ctx: TenantContext): Promise<VoucherData> {
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
      // Sanity floor: a manually-typed SYP rate under 1,000 is never a real
      // market rate, only a dropped digit (127 instead of 12,700) — catch it
      // before it silently under-settles an invoice by three orders of
      // magnitude.
      const sypRateError = saneSypRateError(voucherCurrency, fxRate);
      if (sypRateError) throw new BusinessRuleError(sypRateError);
      const voucherFx: FxSide = { currency: voucherCurrency, exchangeRate: fxRate };

      // Contract: input.amount is CASH that actually moves. Discount is an
      // extra settlement adjustment. Party AR/AP + invoices.paid move by
      // cash + discount. Cashbox moves by cash only — never amount − discount.
      const settled = settlementFromCashAndDiscount(input.amount, input.discount ?? 0);
      const discount = settled.discount;
      const netCash = settled.cash;
      const grossAmount = settled.partySettlement;

      // Negative cash balances are allowed (business rule). The helper only
      // serializes concurrent cash-outs; it no longer hard-blocks the write.
      if (input.method === "cash" && input.kind === "payment") {
        await assertSufficientCashboxBalance(tx, ctx, voucherCurrency, input.date, netCash);
      }

      // What this voucher actually settles on the linked invoice, restated in the
      // INVOICE's currency. Stays null for a standalone payment (no invoice).
      let settledInInvoiceCurrency: number | null = null;
      // The part of it that goes to invoices.paid (≤ remaining). Any excess of a
      // customer receipt stays on the party ledger as credit.
      let appliedToInvoice: number | null = null;
      // Currency + frozen rate of the invoice we just locked, echoed back on the
      // created voucher so the caller can print the counterpart immediately.
      let linkedInvoiceFx: { currency?: string | null; exchangeRate?: number | null } | undefined;
      // FX-LEG FIX: the AR/AP (party) sub-ledger is denominated in the INVOICE's
      // currency — that is the currency the receivable/payable was booked in and
      // the currency `invoices.paid` advances in. When a voucher settles an
      // invoice in a DIFFERENT currency, the party leg must therefore be posted
      // in the invoice currency at the converted amount; posting it in the
      // voucher currency left the invoice-currency statement blind to the
      // settlement while invoices.paid moved, so the two diverged forever.
      let invoiceFx: FxSide | null = null;

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
        invoiceFx = {
          currency: inv.currency ?? "SYP",
          exchangeRate: Number.isFinite(invRate) && invRate > 0 ? invRate : null,
        };
        linkedInvoiceFx = { currency: invoiceFx.currency, exchangeRate: invoiceFx.exchangeRate };
        const enteredRate = isValidFxRate(input.exchangeRate) ? input.exchangeRate! : null;
        // Same sanity floor, keyed on the INVOICE's currency this time: a USD
        // voucher settling an SYP invoice never re-validates voucherCurrency
        // above (that check only fires when the voucher itself is SYP), so a
        // typo like 127 for a USD-voucher-against-SYP-invoice settlement
        // would otherwise sail through untouched — exactly the case that was
        // reported (39,538,000 ل.س invoice, $120 @ 127 → 15,240 ل.س instead
        // of the ~1.6M a realistic rate produces).
        const crossCurrencySypError = saneSypRateError(invoiceFx.currency, enteredRate);
        if (crossCurrencySypError) throw new BusinessRuleError(crossCurrencySypError);
        // Plain conversion first: only to fail closed when FX is unusable. The
        // amount actually credited is decided below, once the remaining balance
        // is known (`settleAmountAgainstRemaining`).
        const plainSettled = convertForSettlement(
          grossAmount,
          voucherCurrency,
          invoiceFx.currency,
          enteredRate,
        );
        if (plainSettled === null) {
          throw new BusinessRuleError(
            `لا يمكن تسديد فاتورة بعملة ${invoiceFx.currency} بسند بعملة ${voucherCurrency} — ${FX_REQUIRED_MESSAGE}`,
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
        // Linked returns MUST match the original invoice currency (enforced at
        // return create) and reuse that invoice's frozen rate — so the line
        // totals already live in invoice currency. A USD round-trip at two
        // rates created leftover lira on remaining vs the party ledger.
        const [retAgg] = await tx
          .select({
            total: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
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
        const returnsAmount = round2dp(Number(retAgg?.total ?? 0));
        const remaining = round2dp(Number(inv.total) - paidSoFar - returnsAmount);
        // A payment equal to the remaining balance (to the payment currency's
        // smallest unit) settles it EXACTLY — no USD→SYP rounding residual and no
        // false over-payment rejection. Any other amount keeps its plain conversion.
        settledInInvoiceCurrency = settleAmountAgainstRemaining(
          grossAmount,
          voucherCurrency,
          invoiceFx.currency,
          enteredRate,
          remaining,
        );
        if (settledInInvoiceCurrency === null) {
          throw new BusinessRuleError(
            `لا يمكن تسديد فاتورة بعملة ${invoiceFx.currency} بسند بعملة ${voucherCurrency} — ${FX_REQUIRED_MESSAGE}`,
          );
        }
        // Overpayment. A customer RECEIPT larger than the remaining balance is
        // never refused: the invoice is settled in full and the excess stays on
        // the customer's ledger as credit (the party leg below is posted for
        // the full amount; only invoices.paid is capped). Supplier payments
        // keep the strict guard. 0.01 tolerance: the conversion rounds to 2dp
        // once, so an exact settlement can land a fraction of a cent above it.
        if (input.kind === "receipt") {
          const split = splitOverpayment(settledInInvoiceCurrency, remaining);
          // A concession on a payment that already exceeds the debt would be
          // booked as customer credit — i.e. money the customer never paid.
          if (split.excess > 0 && discount > 0) {
            throw new BusinessRuleError(
              "لا يمكن منح مسامحة مع دفعة تتجاوز المتبقي على الفاتورة — أزل المسامحة",
            );
          }
          appliedToInvoice = split.applied;
        } else if (settledInInvoiceCurrency > remaining + 0.01) {
          throw new BusinessRuleError(
            `بعد التحويل ${settledInInvoiceCurrency} ${invoiceFx.currency} يتجاوز المتبقي ${remaining} ${invoiceFx.currency}`,
          );
        } else {
          appliedToInvoice = settledInInvoiceCurrency;
        }
      }

      const voucherBaseAmount = computeBaseEquivalent(grossAmount, voucherCurrency, fxRate);
      const legFx = (debit: number, credit: number) => ({
        exchangeRate: fxRate,
        baseDebit: computeBaseEquivalent(debit, voucherCurrency, fxRate),
        baseCredit: computeBaseEquivalent(credit, voucherCurrency, fxRate),
      });

      // FX-LEG FIX — the party (AR/AP) leg is denominated in the INVOICE's
      // currency, not the voucher's. A USD receipt against an SYP invoice must
      // credit the party's SYP sub-ledger by the converted SYP amount (the same
      // amount that advances invoices.paid), otherwise the SYP statement never
      // sees the settlement while the invoice shows it paid. The cash leg keeps
      // the voucher's currency — that is the money that physically moved.
      // Both legs freeze their own rate; the bases still balance to the same
      // USD value, so double-entry in the base currency is preserved.
      const partyCurrency = invoiceFx?.currency ?? voucherCurrency;
      const partyFx = invoiceFx?.exchangeRate ?? fxRate;
      const partyAmount = settledInInvoiceCurrency ?? grossAmount;
      const partyLegFx = (debit: number, credit: number) => ({
        exchangeRate: partyFx,
        baseDebit: computeBaseEquivalent(debit, partyCurrency, partyFx),
        baseCredit: computeBaseEquivalent(credit, partyCurrency, partyFx),
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
          amount: grossAmount,
          discount,
          currency: voucherCurrency,
          appliedAmount: appliedToInvoice,
          exchangeRate: storedExchangeRate,
          baseAmount: voucherBaseAmount,
          method: input.method,
          notesPrint: input.notesPrint,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
          clientOperationId: ctx.clientOperationId ?? null,
        })
        .returning();

      // Standard double-entry with optional settlement discount:
      //   input.amount = cash that moves; discount = settlement adjustment
      //   stored amount = partySettlement (cash + discount) so print
      //   (amount − discount) still yields cash for historical rows.
      //   receipt: Dr cash(cash) [+ Dr discount_expense] Cr party(cash+discount)
      //   payment: Dr party(cash+discount) Cr cash(cash) [+ Cr discount_income]
      const isPayment = input.kind === "payment";
      const refType = isPayment ? "payment_out" : "receipt_in";
      const cashImpact = input.method === "cash" ? (isPayment ? "out" : "in") : "none";
      const discountType = isPayment ? "settlement_discount_income" : "settlement_discount_expense";
      const ledgerRows = [
        {
          ...partyLegFx(isPayment ? partyAmount : 0, isPayment ? 0 : partyAmount),
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          date: input.date,
          type: refType,
          debit: isPayment ? partyAmount : 0,
          credit: isPayment ? 0 : partyAmount,
          currency: partyCurrency,
          cashImpact: "none" as const,
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "سند دفع" : "سند قبض"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
        {
          ...legFx(isPayment ? 0 : netCash, isPayment ? netCash : 0),
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "cash",
          debit: isPayment ? 0 : netCash,
          credit: isPayment ? netCash : 0,
          currency: voucherCurrency,
          cashImpact,
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "نقدية مدفوعة" : "نقدية مقبوضة"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
      ];
      if (discount > 0) {
        ledgerRows.push({
          ...legFx(isPayment ? 0 : discount, isPayment ? discount : 0),
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: discountType,
          debit: isPayment ? 0 : discount,
          credit: isPayment ? discount : 0,
          currency: voucherCurrency,
          cashImpact: "none" as const,
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "دخل خصم دفعة" : "مصروف خصم دفعة"} ${autoNumber}`,
          createdBy: ctx.userId,
        });
      }

      // FX-LEG FIX (balancing side) — when the party leg is posted in the
      // invoice currency but the cash moved in a different voucher currency,
      // the two sides carry different USD base values whenever the voucher's
      // entered rate differs from the invoice's frozen rate. The receivable was
      // booked at the invoice's rate; the cash moved at the voucher's rate; the
      // difference is a realized FX gain/loss. It MUST be posted as its own leg
      // or the base-currency ledger is out of balance by exactly that amount.
      // Posted in BASE currency with no party: it is a P&L item, and must not
      // perturb the party's invoice-currency sub-ledger (which reconciles
      // against invoices.paid).
      if (partyCurrency !== voucherCurrency) {
        // FIN-17: `?? 0` used to substitute zero for an unconvertible side,
        // which fabricates an fx_gain/fx_loss leg equal to the OTHER side's
        // full base value and unbalances the base-currency ledger. Both sides
        // must be restatable in base currency or the voucher is refused.
        const partyBase = computeBaseEquivalent(partyAmount, partyCurrency, partyFx);
        const cashBase = computeBaseEquivalent(grossAmount, voucherCurrency, fxRate);
        if (partyBase === null || cashBase === null) {
          throw new BusinessRuleError(
            `تعذّر احتساب فرق الصرف بين عملة الطرف ${partyCurrency} وعملة السند ${voucherCurrency} — ${FX_REQUIRED_MESSAGE}`,
          );
        }
        const fxDiff = round2dp(partyBase - cashBase);
        if (Math.abs(fxDiff) >= 0.01) {
          // Sign rules (verified by hand on both kinds):
          //  receipt, fxDiff>0: receivable relief (base) exceeds cash received → LOSS (Dr).
          //  receipt, fxDiff<0: cash received exceeds receivable relief → GAIN (Cr).
          //  payment, fxDiff>0: payable relief exceeds cash paid → GAIN (Cr).
          //  payment, fxDiff<0: cash paid exceeds payable relief → LOSS (Dr).
          const isDebit = isPayment ? fxDiff < 0 : fxDiff > 0;
          const abs = Math.abs(fxDiff);
          ledgerRows.push({
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: isDebit ? "fx_loss" : "fx_gain",
            exchangeRate: 1,
            baseDebit: isDebit ? abs : 0,
            baseCredit: isDebit ? 0 : abs,
            debit: isDebit ? abs : 0,
            credit: isDebit ? 0 : abs,
            currency: BASE_CURRENCY,
            cashImpact: "none" as const,
            referenceType: refType,
            referenceId: row.id,
            referenceNumber: autoNumber,
            description: `فرق سعر الصرف ${autoNumber}`,
            createdBy: ctx.userId,
          });
        }
      }
      await tx.insert(ledgerEntries).values(ledgerRows);

      // Maintain invoices.paid transactionally so amountDue (total-paid) stays
      // consistent when vouchers are collected or cancelled (fix P0-LOGIC-3).
      // `paid` is denominated in the INVOICE's currency, so a foreign-currency
      // voucher credits its converted value — never its raw amount.
      if (input.invoiceId) {
        await tx
          .update(invoices)
          .set({
            paid: sql`${invoices.paid} + ${appliedToInvoice ?? settledInInvoiceCurrency ?? grossAmount}`,
            updatedAt: new Date(),
          })
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      return this.toDomain(row, linkedInvoiceFx);
    });
  }

  async cancel(
    id: string,
    cancelledBy: string,
    ctx: TenantContext,
    expectedVersion: number,
  ): Promise<VoucherData> {
    return this.db.transaction(async (tx) => {
      // P0-001: lock the row first for version check
      const [currentRow] = await tx
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.id, id),
            eq(vouchers.tenantId, ctx.tenantId),
            eq(vouchers.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!currentRow) throw new Error("Voucher not found or already cancelled");
      // P0-001: optimistic concurrency — fail fast if version mismatch
      if (currentRow.version !== expectedVersion) {
        throw Object.assign(
          new Error(`Stale version: expected ${expectedVersion}, current ${currentRow.version}`),
          {
            code: "STALE_VERSION" as const,
          },
        );
      }
      // Mirror create()'s guard: cancelling reverses the ledger leg and (for
      // cash) the cashbox balance on the voucher's own date — the same
      // financial write surface a closed day protects against. Without this,
      // a receipt/payment/transfer dated on an already-closed day could still
      // be cancelled, silently altering a reconciled day after the fact.
      await assertDayUnlocked(tx, ctx.tenantId, currentRow.date);

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

      // Read the party (AR/AP) leg BEFORE it is cancelled: it is the exact amount
      // create() credited to invoices.paid, including an exact-closure amount that
      // a plain re-conversion of the voucher amount would not reproduce.
      const [postedPartyLeg] = await tx
        .select({
          debit: ledgerEntries.debit,
          credit: ledgerEntries.credit,
          currency: ledgerEntries.currency,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            or(
              eq(ledgerEntries.referenceType, "payment_out"),
              eq(ledgerEntries.referenceType, "receipt_in"),
            ),
            isNotNull(ledgerEntries.partyId),
            eq(ledgerEntries.status, "active"),
          ),
        )
        .limit(1);
      const postedPartyAmount =
        postedPartyLeg != null
          ? Number(row.kind === "payment" ? postedPartyLeg.debit : postedPartyLeg.credit)
          : null;

      // A customer receipt may carry credit (on-account payment or overpaid
      // excess). Snapshot the customer's unattached position now, while the
      // ledger leg is still active, to refuse a cancel whose credit was already
      // spent on later invoices (checked after the reversal below).
      const creditCheck =
        row.kind === "receipt" && row.partyKind === "customer" && postedPartyLeg?.currency
          ? {
              currency: postedPartyLeg.currency,
              before: (
                await customerCreditPosition(tx, ctx.tenantId, row.partyId, postedPartyLeg.currency)
              ).unattached,
            }
          : null;

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
        //
        // FIN-17: this used to fall back to the RAW amount when conversion was
        // impossible, subtracting e.g. EUR units from a SYP `paid` counter —
        // the exact cross-currency corruption create() refuses to commit. A
        // voucher can only exist if its settlement converted, so a null here
        // means the stored rate is unusable; fail closed instead of corrupting
        // the invoice balance.
        const voucherCurrencyOnCancel = row.currency ?? "SYP";
        // applied_amount is exactly what create() added to invoices.paid (an
        // overpaid receipt's excess never reached the invoice). Legacy rows
        // (NULL) keep the posted-party-leg rule.
        const reversed =
          row.appliedAmount !== null && row.appliedAmount !== undefined
            ? round2dp(Number(row.appliedAmount))
            : postedPartyAmount !== null && Number.isFinite(postedPartyAmount) && postedPartyAmount > 0
            ? round2dp(postedPartyAmount)
            : convertForSettlement(
                Number(row.amount),
                voucherCurrencyOnCancel,
                invoiceFx.currency,
                isValidFxRate(row.exchangeRate) ? Number(row.exchangeRate) : null,
              );
        if (reversed === null) {
          throw new BusinessRuleError(
            `لا يمكن إلغاء سند بعملة ${voucherCurrencyOnCancel} مرتبط بفاتورة بعملة ${invoiceFx.currency} — ${FX_REQUIRED_MESSAGE}`,
          );
        }
        await tx
          .update(invoices)
          .set({ paid: sql`GREATEST(0, ${invoices.paid} - ${reversed})`, updatedAt: new Date() })
          .where(and(eq(invoices.id, row.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      if (creditCheck) {
        const after = await customerCreditPosition(
          tx,
          ctx.tenantId,
          row.partyId,
          creditCheck.currency,
        );
        await assertCreditNotOverdrawn(
          tx,
          ctx.tenantId,
          row.partyId,
          creditCheck.currency,
          creditCheck.before,
          after.unattached,
        );
      }

      return this.toDomain(row);
    });
  }

  /** Currency + frozen rate of the linked invoice, when the row was joined to it. */
  private toDomain(
    row: typeof vouchers.$inferSelect,
    invoiceFx?: { currency?: string | null; exchangeRate?: number | null; number?: string | null },
  ): VoucherData {
    return Voucher.reconstitute(this.mapRow(row, invoiceFx)).toData();
  }

  private mapRow(
    row: typeof vouchers.$inferSelect,
    invoiceFx?: { currency?: string | null; exchangeRate?: number | null; number?: string | null },
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
      discount: row.discount ?? 0,
      currency: row.currency,
      exchangeRate: row.exchangeRate ?? undefined,
      baseAmount: row.baseAmount ?? undefined,
      // Only present when the row was selected alongside its invoice (LEFT JOIN);
      // standalone payments simply leave these undefined.
      invoiceCurrency: invoiceFx?.currency ?? undefined,
      invoiceExchangeRate: invoiceFx?.exchangeRate ?? undefined,
      invoiceNumber: invoiceFx?.number ?? undefined,
      appliedAmount: row.appliedAmount ?? undefined,
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
