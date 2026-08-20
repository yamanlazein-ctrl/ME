export type InvoiceLineCalc = {
  quantityKg: number;
  pricePerKg: number;
  discountAmount: number;
};

export type InvoiceCalc = {
  lines: readonly InvoiceLineCalc[];
  discount?: number;
  tax?: number;
  shipping?: number;
};

export function lineTotal(l: InvoiceLineCalc): number {
  const gross = l.quantityKg * l.pricePerKg;
  // Matches the backend computeSubtotal: round each line, then sum. The server
  // owns monetary truth; this client calculation is only a pre-submit preview
  // and must use the identical per-line rounding so the preview never diverges
  // from the stored subtotal.
  return Math.max(0, Math.round(gross - (l.discountAmount || 0)));
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

export function invoiceShipping(inv: InvoiceCalc): number {
  return inv.shipping ?? 0;
}

export function invoiceTotal(inv: InvoiceCalc): number {
  const subtotal = invoiceSubtotal(inv);
  const discount = invoiceDiscount(inv);
  const tax = invoiceTax(inv);
  const shipping = inv.shipping ?? 0;
  return subtotal - discount + tax + shipping;
}

export function invoiceRemaining(total: number, paid: number): number {
  return Math.max(0, total - paid);
}
