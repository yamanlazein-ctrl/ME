export type InvoiceLineCalc = {
  quantityKg: number;
  pricePerKg: number;
  discountAmount: number;
};

export type InvoiceCalc = {
  lines: readonly InvoiceLineCalc[];
  discount?: number;
  tax?: number;
};

export function lineTotal(l: InvoiceLineCalc): number {
  const gross = l.quantityKg * l.pricePerKg;
  // Fixed-amount (not percentage) line discount, floored at zero so a discount
  // larger than the line gross never produces a negative line total.
  return Math.max(0, gross - (l.discountAmount || 0));
}

export function invoiceSubtotal(inv: InvoiceCalc): number {
  return inv.lines.reduce((s, l) => s + lineTotal(l), 0);
}

export function invoiceDiscount(inv: InvoiceCalc): number {
  return inv.discount ?? 0;
}

export function invoiceTax(inv: InvoiceCalc): number {
  return inv.tax ?? 0;
}

export function invoiceTotal(inv: InvoiceCalc): number {
  const subtotal = invoiceSubtotal(inv);
  const discount = invoiceDiscount(inv);
  const tax = invoiceTax(inv);
  return subtotal - discount + tax;
}

export function invoiceRemaining(total: number, paid: number): number {
  return Math.max(0, total - paid);
}
