import type { IInvoiceRepository } from "../../ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../ports/IVoucherRepository.js";
import type { IPartyRepository } from "../../ports/IPartyRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { withTenantTx } from "../../../infrastructure/orm/engine.js";
import type { PartyDeletionImpact } from "../../../infrastructure/repositories/partyDeletionImpact.js";
import { partyDeletionHelpers } from "../../../infrastructure/repositories/engineHelpers.js";

/** Engine-selected (PG or SQLite twin); same signatures as before. */
export const computePartyDeletionImpact: typeof import("../../../infrastructure/repositories/partyDeletionImpact.js").computePartyDeletionImpact =
  async (...a) => (await partyDeletionHelpers()).computePartyDeletionImpact(...a);
export const listActiveLinkedIds: typeof import("../../../infrastructure/repositories/partyDeletionImpact.js").listActiveLinkedIds =
  async (...a) => (await partyDeletionHelpers()).listActiveLinkedIds(...a);
export const listPartyLinkedDocs: typeof import("../../../infrastructure/repositories/partyDeletionImpact.js").listPartyLinkedDocs =
  async (...a) => (await partyDeletionHelpers()).listPartyLinkedDocs(...a);

/**
 * Cascade party delete using EXISTING cancel paths (invoice → voucher → party),
 * inside ONE ACID transaction.
 *
 * ATOMICITY: the whole cascade runs inside a single `withTenantTx`. Every
 * repository below is constructed with the ambient-aware `ambientDb(db)` proxy
 * (see infrastructure/di/container.ts), so its internal `this.db.transaction(...)`
 * becomes a SAVEPOINT on THIS transaction instead of checking out a second
 * pooled connection. One commit for the entire cascade; any failure rolls back
 * the invoices and vouchers already processed. There is no partial delete left
 * behind.
 *
 * The accounting itself is untouched: each document is reversed through the
 * existing `invoiceRepo.cancel` / `voucherRepo.cancel` paths (stock + ledger +
 * cashbox legs). No new financial logic is introduced here.
 *
 * COMPLETENESS: the work list is `listActiveLinkedIds`, which walks EVERY
 * active invoice/voucher for the party in bounded pages. The impact sheet's
 * document arrays are capped previews for display only; the cascade used to
 * iterate them, so a customer with 150 invoices had 100 cancelled and 50 left
 * active pointing at a soft-cancelled customer.
 *
 * OCC is preserved, never bypassed: `expectedVersion` is checked against the
 * impact's version before any write, and the party itself is cancelled with a
 * version freshly re-read inside the same transaction.
 */
export async function purgePartyCascadeUseCase(opts: {
  partyId: string;
  ctx: TenantContext;
  expectedVersion: number;
  partyRepo: IPartyRepository;
  invoiceRepo: IInvoiceRepository;
  voucherRepo: IVoucherRepository;
}): Promise<{ ok: true; impact: PartyDeletionImpact } | { ok: false; error: string }> {
  const { partyId, ctx, partyRepo, invoiceRepo, voucherRepo } = opts;

  // The single commit/rollback boundary for the entire cascade. Nested
  // repository transactions join it as savepoints (see note above).
  try {
    return await withTenantTx(ctx.tenantId, async (tx) => {
      let impact: PartyDeletionImpact;
      try {
        // Reads on the SAME transaction the cascade writes on.
        impact = await computePartyDeletionImpact(tx, ctx.tenantId, partyId);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : "تعذّر فحص ارتباطات الطرف");
      }

      const impactVersion = Number(impact.version);
      const expected = Number(opts.expectedVersion);
      if (!Number.isFinite(expected) || impactVersion !== expected) {
        throw new Error(
          `تعارض في الإصدار: الإصدار الحالي ${impactVersion} والمتوقع ${expected}. حدّث الصفحة ثم أعد المحاولة.`,
        );
      }

      // Blocking is decided by the EXACT counts, never by a capped preview.
      if (impact.counts.returns > 0) {
        throw new Error(
          `لا يمكن حذف ${impact.kindLabel} لوجود ${impact.counts.returns} مرتجع نشط مرتبط. ألغِ المرتجعات أولاً.`,
        );
      }

      if (impact.counts.orders > 0) {
        throw new Error(
          `لا يمكن حذف ${impact.kindLabel} لوجود ${impact.counts.orders} طلبية مفتوحة مرتبطة. أغلق أو ألغِ الطلبيات أولاً.`,
        );
      }

      // Guard against drift between the count and the walk: if the walk finds
      // more documents than the count promised, the counts are stale and this
      // transaction must not proceed on a picture the operator never saw.
      const invoices = await listActiveLinkedIds(tx, ctx.tenantId, partyId, impact.kind, "invoice");
      const vouchers = await listActiveLinkedIds(tx, ctx.tenantId, partyId, impact.kind, "voucher");
      if (invoices.length !== impact.counts.invoices || vouchers.length !== impact.counts.vouchers) {
        throw new Error(
          `تغيّرت الارتباطات أثناء الحذف (المتوقع ${impact.counts.invoices} فاتورة و${impact.counts.vouchers} سند، الموجود ${invoices.length} و${vouchers.length}). حدّث الصفحة ثم أعد المحاولة.`,
        );
      }

      // Cancel invoices first (existing accounting: stock + ledger + cashbox reverse).
      for (const inv of invoices) {
        const current = await invoiceRepo.findById(inv.id, ctx);
        if (!current || current.status === "cancelled") continue;
        try {
          await invoiceRepo.cancel(inv.id, ctx.userId, ctx, current.version);
        } catch (e) {
          throw new Error(
            `تعذّر إلغاء ${inv.label}: ${e instanceof Error ? e.message : "خطأ"}. لم يُحذف أي سجل — تم التراجع عن العملية كاملة.`,
          );
        }
      }

      // Remaining standalone vouchers (invoice-linked ones may already be cancelled).
      for (const v of vouchers) {
        const current = await voucherRepo.findById(v.id, ctx);
        if (!current || current.status === "cancelled") continue;
        try {
          await voucherRepo.cancel(v.id, ctx.userId, ctx, current.version);
        } catch (e) {
          throw new Error(
            `تعذّر إلغاء ${v.label}: ${e instanceof Error ? e.message : "خطأ"}. لم يُحذف أي سجل — تم التراجع عن العملية كاملة.`,
          );
        }
      }

      // Soft-cancel the party with a FRESH version read inside this
      // transaction, so the concurrent-edit check still runs (OCC preserved).
      const fresh = await partyRepo.findById(partyId, ctx);
      if (fresh && fresh.status !== "cancelled") {
        try {
          await partyRepo.cancel(partyId, ctx.userId, ctx, fresh.version);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "فشل حذف الطرف";
          if (/Stale version|STALE_VERSION/i.test(msg)) {
            throw new Error(
              `تعارض في الإصدار: الإصدار الحالي ${fresh.version + 1}. حدّث الصفحة ثم أعد المحاولة.`,
            );
          }
          throw new Error(msg);
        }
      }

      return { ok: true as const, impact };
    });
  } catch (e) {
    // Every write above already rolled back with the transaction. Nothing was
    // partially deleted — the party and its documents are exactly as they were
    // before the attempt.
    return { ok: false, error: e instanceof Error ? e.message : "فشل حذف الطرف" };
  }
}

export async function getPartyDeletionImpactUseCase(
  partyId: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: PartyDeletionImpact } | { ok: false; error: string }> {
  try {
    const impact = await withTenantTx(ctx.tenantId, (tx) =>
      computePartyDeletionImpact(tx, ctx.tenantId, partyId),
    );
    return { ok: true, data: impact };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "تعذّر فحص ارتباطات الطرف" };
  }
}

/** Re-export impact helper for callers that already hold a tx (tests). */
