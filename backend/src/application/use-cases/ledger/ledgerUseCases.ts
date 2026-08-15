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
): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  try {
    await repo.cancelByReference(referenceType, referenceId, cancelledBy, ctx);
    return { ok: true };
  } catch (e) {
    // Fix C-4: surface the structured ALREADY_CANCELLED code (same pattern
    // as cancelInvoiceUseCase's NOT_FOUND/ALREADY_CANCELLED) so the route
    // can return 409 instead of a generic 422 for a duplicate cancel call.
    const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
    return { ok: false, error: "فشل إلغاء القيد", code };
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
