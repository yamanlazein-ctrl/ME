/**
 * Search-param contract for /payments/new and /receipts/new.
 *
 * F14 (Phase 1 foundation audit): "payment voucher from a cancelled invoice
 * opens an empty /payments/new". Root cause traced to this exact parsing —
 * `invoiceId` did not exist as a recognized search param at all, so even a
 * correctly-built link from the invoice page passing `invoiceId` would have
 * been silently stripped before VoucherForm ever saw it. Extracted as a
 * shared, pure function (both routes had byte-identical logic) so the fix
 * is unit-testable without a router/DOM environment.
 */
export type VoucherNewSearch = { partyId?: string; invoiceId?: string; edit?: string };

export function parseVoucherNewSearch(s: Record<string, unknown>): VoucherNewSearch {
  return {
    partyId: typeof s.partyId === "string" ? s.partyId : undefined,
    invoiceId: typeof s.invoiceId === "string" ? s.invoiceId : undefined,
    edit: typeof s.edit === "string" ? s.edit : undefined,
  };
}
