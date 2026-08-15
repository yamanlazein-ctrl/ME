import type {
  ILedgerRepository,
  LedgerFilter,
  WriteLedgerEntry,
} from "../../ports/ILedgerRepository.js";
import type { TenantContext, PaginatedResult, UUID } from "../../../domain/types/index.js";
import type { LedgerEntryData, PartyBalance } from "../../../domain/entities/LedgerEntry.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function findLedgerEntryUseCase(
  repo: ILedgerRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: LedgerEntryData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listLedgerUseCase(
  repo: ILedgerRepository,
  filter: LedgerFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<LedgerEntryData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض سجلات الأستاذ" };
  }
}

export async function listPartyLedgerUseCase(
  repo: ILedgerRepository,
  partyId: UUID,
  ctx: TenantContext,
): Promise<Result<LedgerEntryData[]>> {
  try {
    return { ok: true, data: await repo.listByParty(partyId, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض سجل الطرف" };
  }
}

export async function writeLedgerUseCase(
  repo: ILedgerRepository,
  entries: WriteLedgerEntry[],
  ctx: TenantContext,
): Promise<Result<LedgerEntryData[]>> {
  for (const e of entries) {
    const hasDebit = (e.debit ?? 0) > 0;
    const hasCredit = (e.credit ?? 0) > 0;
    if (hasDebit && hasCredit)
      return { ok: false, error: "القيد لا يمكن أن يحتوي على مدين ودائن معاً" };
    if (!hasDebit && !hasCredit) return { ok: false, error: "القيد يجب أن يحتوي على مدين أو دائن" };
  }

  // Fix C-7 (forensic audit 2026-08-15, live-reproduced): the loop above
  // only checks that each INDIVIDUAL entry is single-sided — it never
  // checked that the BATCH as a whole is balanced (Σdebit = Σcredit).
  // A batch of length 1 (the schema's minimum) with only a debit, or any
  // batch whose legs don't net to zero, was accepted and inserted
  // verbatim, letting any authenticated writer silently unbalance the
  // double-entry ledger and inflate a party's statement balance by an
  // arbitrary amount. Balance is required PER CURRENCY, never combined —
  // SYP and USD entries in the same batch (currency is per-entry, per
  // ledger.schema.ts) must each independently net to zero; summing across
  // currencies would defeat the entire point of the check.
  const byCurrency = new Map<string, { debit: number; credit: number }>();
  for (const e of entries) {
    const currency = e.currency ?? "SYP";
    const agg = byCurrency.get(currency) ?? { debit: 0, credit: 0 };
    agg.debit += e.debit ?? 0;
    agg.credit += e.credit ?? 0;
    byCurrency.set(currency, agg);
  }
  for (const [currency, agg] of byCurrency) {
    if (agg.debit !== agg.credit) {
      return {
        ok: false,
        error: `القيد المجمّع غير متوازن بعملة ${currency}: مدين ${agg.debit} ≠ دائن ${agg.credit}`,
      };
    }
  }

  try {
    return { ok: true, data: await repo.writeMany(entries, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تسجيل القيد" };
  }
}

export async function cancelLedgerByReferenceUseCase(
  repo: ILedgerRepository,
  referenceType: string,
  referenceId: UUID,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await repo.cancelByReference(referenceType, referenceId, cancelledBy, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "فشل إلغاء القيد" };
  }
}

export async function getPartyBalanceUseCase(
  repo: ILedgerRepository,
  partyId: UUID,
  currency: string,
  ctx: TenantContext,
): Promise<Result<PartyBalance>> {
  try {
    return { ok: true, data: await repo.getBalance(partyId, ctx, currency) };
  } catch (e) {
    return { ok: false, error: "فشل حساب الرصيد" };
  }
}

export async function getPartyBalanceByDateUseCase(
  repo: ILedgerRepository,
  partyId: UUID,
  date: string,
  currency: string,
  ctx: TenantContext,
): Promise<Result<PartyBalance>> {
  try {
    return { ok: true, data: await repo.getBalanceByDate(partyId, date, ctx, currency) };
  } catch (e) {
    return { ok: false, error: "فشل حساب الرصيد" };
  }
}
