import type { IVoucherRepository } from "../../ports/IVoucherRepository.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import type { IPartyRepository } from "../../ports/IPartyRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { VoucherMethod } from "../../../domain/types/index.js";
import type { VoucherData } from "../../../domain/entities/Voucher.js";
import { BusinessRuleError } from "../../../domain/errors/index.js";
import { allocateSettlementPayment } from "@erp/shared";
import { createVoucherUseCase } from "../vouchers/voucherUseCases.js";
import { nextDocumentNumber } from "../../../infrastructure/utils/documentNumbers.js";
import { db } from "../../../infrastructure/orm/drizzle.js";
import { invoices } from "../../../infrastructure/orm/schemas/invoice.table.js";
import { returns } from "../../../infrastructure/orm/schemas/return.table.js";
import { returnLines } from "../../../infrastructure/orm/schemas/return-line.table.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { round2dp } from "@erp/shared";

export type SettleInvoicesInput = {
  invoiceIds: string[];
  amountPaid: number;
  currency: "SYP" | "USD" | "EUR";
  exchangeRate?: number;
  date?: string;
  method?: VoucherMethod;
  notesInternal?: string;
  notesPrint?: string;
};

export type SettleInvoicesResult = {
  batchNumber: string;
  currency: string;
  exchangeRate: number | null;
  amountPaid: number;
  totalDueInSettlement: number;
  totalAllocated: number;
  date: string;
  method: VoucherMethod;
  vouchers: VoucherData[];
  allocations: Array<{
    invoiceId: string;
    invoiceNumber: string;
    invoiceCurrency: string;
    remainingBefore: number;
    amountInSettlementCurrency: number;
    amountInInvoiceCurrency: number;
    remainingAfter: number;
    voucherId: string;
    voucherNumber: string;
  }>;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Multi-invoice cash settlement: one SET batch number, one voucher per
 * allocated invoice (reuses voucher FX / cashbox / invoices.paid engine).
 * Invoice historical exchange rates are never mutated.
 */
export async function settleInvoicesUseCase(
  voucherRepo: IVoucherRepository,
  auditRepo: IAuditRepository,
  partyRepo: IPartyRepository,
  partyId: string,
  partyKind: "customer" | "supplier",
  input: SettleInvoicesInput,
  ctx: TenantContext,
): Promise<Result<SettleInvoicesResult>> {
  try {
    const party = await partyRepo.findById(partyId, ctx);
    if (!party || party.kind !== partyKind) {
      return { ok: false, error: partyKind === "customer" ? "العميل غير موجود" : "المورد غير موجود" };
    }

    const ids = [...new Set(input.invoiceIds.filter(Boolean))];
    if (ids.length === 0) return { ok: false, error: "اختر فاتورة واحدة على الأقل" };
    if (!(input.amountPaid > 0)) return { ok: false, error: "مبلغ الدفعة يجب أن يكون أكبر من صفر" };

    const date = input.date ?? new Date().toISOString().slice(0, 10);
    const method: VoucherMethod = input.method ?? "cash";
    const voucherKind = partyKind === "customer" ? "receipt" : "payment";

    const invRows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        total: invoices.total,
        paid: invoices.paid,
        status: invoices.status,
        currency: invoices.currency,
        partyId: invoices.partyId,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, ctx.tenantId), inArray(invoices.id, ids)));

    if (invRows.length !== ids.length) {
      return { ok: false, error: "بعض الفواتير المحددة غير موجودة" };
    }

    for (const inv of invRows) {
      if (inv.partyId !== partyId) {
        return { ok: false, error: `الفاتورة ${inv.number} لا تخص هذا الطرف` };
      }
      if (inv.status === "cancelled") {
        return { ok: false, error: `الفاتورة ${inv.number} ملغاة` };
      }
    }

    // Returns reduce amount owed (same rule as voucher create).
    const returnAggs = await db
      .select({
        invoiceId: returns.originalInvoiceId,
        total: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
      })
      .from(returnLines)
      .innerJoin(returns, eq(returnLines.returnId, returns.id))
      .where(
        and(
          eq(returns.tenantId, ctx.tenantId),
          eq(returns.status, "active"),
          inArray(returns.originalInvoiceId, ids),
        ),
      )
      .groupBy(returns.originalInvoiceId);
    const returnsByInvoice = new Map(
      returnAggs.map((r) => [r.invoiceId as string, round2dp(Number(r.total ?? 0))]),
    );

    const open = invRows.map((inv) => {
      const remaining = round2dp(
        Number(inv.total) - Number(inv.paid ?? 0) - (returnsByInvoice.get(inv.id) ?? 0),
      );
      return {
        invoiceId: inv.id,
        number: inv.number,
        date: inv.date,
        currency: (inv.currency as string) ?? "SYP",
        remaining: Math.max(0, remaining),
      };
    });

    if (open.some((o) => o.remaining <= 0)) {
      const closed = open.filter((o) => o.remaining <= 0).map((o) => o.number);
      return { ok: false, error: `الفواتير التالية مسدّدة بالكامل: ${closed.join(", ")}` };
    }

    let allocated;
    try {
      allocated = allocateSettlementPayment({
        invoices: open,
        amountPaid: input.amountPaid,
        settlementCurrency: input.currency,
        exchangeRate: input.exchangeRate,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "تعذّر توزيع الدفعة" };
    }

    const batchNumber = await nextDocumentNumber("settlement", ctx.tenantId);
    // The SET batch number is what ties the N vouchers back into one settlement
    // (invoice tracking groups by it), so it must survive custom user notes too.
    const withBatch = (text: string | undefined, fallback: string) => {
      const t = text?.trim();
      if (!t) return fallback;
      return t.includes(batchNumber) ? t : `${t} — ${batchNumber}`;
    };
    const notesInternal = withBatch(
      input.notesInternal,
      `دفعة ${batchNumber} — ${allocated.allocations.length} فاتورة`,
    );
    const notesPrint = withBatch(input.notesPrint, `جزء من الدفعة ${batchNumber}`);

    const vouchers: VoucherData[] = [];
    const resultLines: SettleInvoicesResult["allocations"] = [];

    for (const line of allocated.allocations) {
      const created = await createVoucherUseCase(
        voucherRepo,
        auditRepo,
        {
          kind: voucherKind,
          date,
          partyId,
          partyKind,
          invoiceId: line.invoiceId,
          amount: line.amountInSettlementCurrency,
          currency: input.currency,
          exchangeRate: input.exchangeRate,
          method,
          notesInternal,
          notesPrint,
        },
        ctx,
      );
      if (!created.ok) {
        // Throw so an outer withTenantTx rolls back every prior voucher in the batch.
        throw new BusinessRuleError(
          `فشل تسديد الفاتورة ${line.number ?? line.invoiceId}: ${created.error}`,
        );
      }
      vouchers.push(created.data);
      resultLines.push({
        invoiceId: line.invoiceId,
        invoiceNumber: line.number ?? created.data.number,
        invoiceCurrency: line.invoiceCurrency,
        remainingBefore: line.remainingBefore,
        amountInSettlementCurrency: line.amountInSettlementCurrency,
        amountInInvoiceCurrency: line.amountInInvoiceCurrency,
        remainingAfter: line.remainingAfterInInvoiceCurrency,
        voucherId: created.data.id,
        voucherNumber: created.data.number,
      });
    }

    return {
      ok: true,
      data: {
        batchNumber,
        currency: input.currency,
        exchangeRate: input.exchangeRate ?? null,
        amountPaid: round2dp(input.amountPaid),
        totalDueInSettlement: allocated.totalDueInSettlement,
        totalAllocated: allocated.totalAllocated,
        date,
        method,
        vouchers,
        allocations: resultLines,
      },
    };
  } catch (e) {
    if (e instanceof BusinessRuleError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "فشل تسجيل الدفعة" };
  }
}
