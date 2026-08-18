export type InvoiceStatus = "active" | "cancelled";

export type OrderStatus = "open" | "partially_available" | "available" | "fulfilled" | "cancelled";

export type ReturnStatus = "active" | "cancelled";

export type VoucherStatus = "active" | "cancelled";

export type RollStatus = "in_stock" | "exhausted" | "reserved";

export type CashboxDayStatus = "open" | "closed";

export type AllowedTransitions = Record<string, string[]>;

export const INVOICE_TRANSITIONS: AllowedTransitions = {
  active: ["cancelled"],
  cancelled: [],
};

export const ORDER_TRANSITIONS: AllowedTransitions = {
  open: ["partially_available", "available", "cancelled"],
  partially_available: ["available", "cancelled"],
  available: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

export const RETURN_TRANSITIONS: AllowedTransitions = {
  active: ["cancelled"],
  cancelled: [],
};

export const VOUCHER_TRANSITIONS: AllowedTransitions = {
  active: ["cancelled"],
  cancelled: [],
};

export const CASHBOX_DAY_TRANSITIONS: AllowedTransitions = {
  open: ["closed"],
  closed: [],
};

export function canTransition(
  current: string,
  target: string,
  transitions: AllowedTransitions,
): boolean {
  const allowed = transitions[current];
  if (!allowed) return false;
  return allowed.includes(target);
}

export function validateTransition(
  current: string,
  target: string,
  transitions: AllowedTransitions,
  entityLabel: string,
): void {
  if (!canTransition(current, target, transitions)) {
    throw new Error(`Invalid ${entityLabel} status transition: ${current} -> ${target}`);
  }
}
