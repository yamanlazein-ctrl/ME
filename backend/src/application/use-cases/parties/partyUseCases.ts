import type {
  CreatePartyData,
  IPartyRepository,
  PartyFilter,
} from "../../../application/ports/IPartyRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { PartyData } from "../../../domain/entities/Party.js";
import { persistenceErrorMessage } from "../../../infrastructure/errors/persistenceErrorMessage.js";

type PartyUseCaseResult = { ok: true; data: PartyData } | { ok: false; error: string };

type OpeningDirection = "they_owe_us" | "we_owe_them";

/**
 * UI (amount + direction) → the signed SoT of openingJournalRows: positive is
 * "they owe us" for a customer and "we owe them" for a supplier.
 */
export function signedOpeningBalance(kind: string, amount: number, direction: OpeningDirection): number {
  const positive = kind === "supplier" ? direction === "we_owe_them" : direction === "they_owe_us";
  return amount === 0 ? 0 : positive ? amount : -amount;
}

/** Body of PUT /customers|suppliers/:id/opening (also the sync updateInput `opening`). */
type OpeningUpdate = {
  amount: number;
  direction: OpeningDirection;
  currency: string;
  date: string;
  note?: string | null;
};

export async function createPartyUseCase(
  repo: IPartyRepository,
  input: CreatePartyData,
  ctx: TenantContext,
): Promise<PartyUseCaseResult> {
  if (!input.name?.trim()) return { ok: false, error: "الاسم مطلوب" };
  if (!input.kind) return { ok: false, error: "نوع الطرف مطلوب" };

  // The UI sends an absolute amount + direction; it wins over a signed openingBalance.
  const data =
    input.openingAmount !== undefined && input.openingDirection
      ? { ...input, openingBalance: signedOpeningBalance(input.kind, input.openingAmount, input.openingDirection) }
      : input;

  try {
    const party = await repo.create(data, ctx);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: persistenceErrorMessage(e, "party") };
  }
}

export async function updatePartyUseCase(
  repo: IPartyRepository,
  id: string,
  input: Partial<CreatePartyData>,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<PartyUseCaseResult> {
  try {
    // P0-001: optimistic concurrency check
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
      };
    }
    // The opening balance has its own path (PUT …/:id/opening, synced as an update whose input
    // is `{ opening }`): it re-posts the opening journal, so it never mixes with a field edit.
    const opening = (input as { opening?: OpeningUpdate }).opening;
    if (opening) {
      if (!current) return { ok: false, error: "الطرف غير موجود" };
      const party = await repo.setOpening(
        id,
        {
          openingBalance: signedOpeningBalance(current.kind, opening.amount, opening.direction),
          currency: opening.currency,
          date: opening.date,
          note: opening.note?.trim() || null,
        },
        ctx,
        expectedVersion,
      );
      return { ok: true, data: party };
    }
    const party = await repo.update(id, input, ctx, expectedVersion);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل تحديث الطرف" };
  }
}

export async function findPartyUseCase(
  repo: IPartyRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: PartyData | null } | { ok: false; error: string }> {
  try {
    const party = await repo.findById(id, ctx);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: "فشل البحث عن الطرف" };
  }
}

export async function listPartiesUseCase(
  repo: IPartyRepository,
  filter: PartyFilter,
  ctx: TenantContext,
): Promise<{ ok: true; data: PaginatedResult<PartyData> } | { ok: false; error: string }> {
  try {
    const result = await repo.list(filter, ctx);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: "فشل عرض الأطراف" };
  }
}

export async function cancelPartyUseCase(
  repo: IPartyRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<PartyUseCaseResult> {
  try {
    // P0-001: optimistic concurrency check
    const current = await repo.findById(id, ctx);
    if (!current) {
      return { ok: false, error: "الطرف غير موجود أو محذوف مسبقاً" };
    }
    // DELETE is idempotent by contract. A replay of a delete that already
    // committed (a transport hiccup, a double click, the operator pressing
    // again after a slow response) must report SUCCESS, not a version
    // conflict: the state the caller asked for is already reached. The old
    // code compared versions first, so the replay failed OCC and told the
    // operator that "another session" had edited the record — a message that
    // was never true and that hid a delete which had in fact succeeded.
    if (current.status === "cancelled") {
      return { ok: true, data: current };
    }
    const currentVersion = Number(current.version);
    const expected = Number(expectedVersion);
    if (!Number.isFinite(expected) || currentVersion !== expected) {
      const kindLabel = current.kind === "supplier" ? "المورد" : "العميل";
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي لل${kindLabel} ${currentVersion}، والإصدار الذي قرأته ${Number.isFinite(expected) ? expected : "—"}. حدّث البيانات ثم أعد المحاولة.`,
      };
    }
    const party = await repo.cancel(id, cancelledBy, ctx, expected);
    return { ok: true, data: party };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل إلغاء الطرف";
    if (/Stale version|STALE_VERSION/i.test(msg)) {
      return {
        ok: false,
        error: "تم تعديل السجل أثناء الحذف. حدّث الصفحة ثم أعد المحاولة.",
      };
    }
    // Surface the repository's clear, business-level message (e.g. "لا يمكن
    // حذف العميل لوجود فواتير مرتبطة به") so the API returns it verbatim.
    return { ok: false, error: msg };
  }
}
