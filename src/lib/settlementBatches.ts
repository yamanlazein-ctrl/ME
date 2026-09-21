/**
 * A "settlement" (تسجيل دفعة على الفواتير) is stored as N linked vouchers that
 * all carry the same SET-YYYY-NNNN batch number in their notes. This groups those
 * vouchers back into one logical document so the invoice-tracking screen can list
 * each settlement once.
 */
const BATCH_RE = /\bSET-\d{4}-\d+\b/i;

export type SettlementVoucherLike = {
  id: string;
  partyId: string;
  partyKind: "customer" | "supplier";
  date: string;
  amount: number;
  currency: string;
  status: string;
  notesInternal?: string | null;
  notesPrint?: string | null;
};

export type SettlementBatch = {
  batchNumber: string;
  partyId: string;
  partyKind: "customer" | "supplier";
  date: string;
  currency: string;
  total: number;
  /** "active" while at least one of its vouchers is still active. */
  status: "active" | "cancelled";
  voucherCount: number;
};

export function settlementBatchNumber(v: {
  notesInternal?: string | null;
  notesPrint?: string | null;
}): string | null {
  const m = BATCH_RE.exec(v.notesInternal ?? "") ?? BATCH_RE.exec(v.notesPrint ?? "");
  return m ? m[0].toUpperCase() : null;
}

export function groupSettlementBatches(
  vouchers: readonly SettlementVoucherLike[],
): SettlementBatch[] {
  const byBatch = new Map<string, SettlementBatch>();
  for (const v of vouchers) {
    const batchNumber = settlementBatchNumber(v);
    if (!batchNumber) continue;
    const key = `${v.partyId}|${batchNumber}`;
    const cur = byBatch.get(key);
    const live = v.status !== "cancelled";
    if (!cur) {
      byBatch.set(key, {
        batchNumber,
        partyId: v.partyId,
        partyKind: v.partyKind,
        date: v.date,
        currency: v.currency,
        total: live ? v.amount : 0,
        status: live ? "active" : "cancelled",
        voucherCount: 1,
      });
    } else {
      cur.voucherCount += 1;
      if (live) {
        cur.total += v.amount;
        cur.status = "active";
      }
    }
  }
  return [...byBatch.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
