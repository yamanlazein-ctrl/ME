/**
 * Single settlement contract for customer receipts and supplier payments.
 *
 * `amount` on the wire is the CASH that actually moves.
 * `discount` is a separate settlement adjustment (مسامحة / خصم مكتسب).
 * Party AR/AP is reduced by cash + discount. Cashbox moves by cash only.
 *
 * Never subtract discount from cash. Never mutate historical invoice totals.
 */

import { round2dp } from "./precision.js";

export type SettlementAmounts = {
  /** Actual cash in (receipt) or out (payment). */
  cash: number;
  /** Discount allowed (customer) or discount received (supplier). */
  discount: number;
  /** Reduction of party receivable/payable = cash + discount. */
  partySettlement: number;
};

export function settlementFromCashAndDiscount(
  cashAmount: number,
  discountAmount = 0,
): SettlementAmounts {
  const cash = round2dp(cashAmount);
  const discount = round2dp(discountAmount);
  if (!Number.isFinite(cash) || cash < 0) {
    throw new Error("المبلغ النقدي لا يمكن أن يكون سالباً");
  }
  if (!Number.isFinite(discount) || discount < 0) {
    throw new Error("الخصم لا يمكن أن يكون سالباً");
  }
  const partySettlement = round2dp(cash + discount);
  if (!(partySettlement > 0)) {
    throw new Error("يجب أن يكون مجموع المبلغ النقدي والمسامحة أكبر من صفر");
  }
  return { cash, discount, partySettlement };
}

/**
 * After FIFO allocation of (cash + discount) across invoices, assign the
 * cash portion first, then the remainder of each line is discount.
 * Invoice historical totals are not consulted and must not be mutated.
 */
export function splitCashAndDiscountAcrossLines(
  lineAmounts: number[],
  cashAmount: number,
): Array<{ cash: number; discount: number }> {
  let cashLeft = round2dp(Math.max(0, cashAmount));
  return lineAmounts.map((raw) => {
    const line = round2dp(raw);
    const cash = round2dp(Math.min(cashLeft, Math.max(0, line)));
    const discount = round2dp(Math.max(0, line - cash));
    cashLeft = round2dp(cashLeft - cash);
    return { cash, discount };
  });
}
