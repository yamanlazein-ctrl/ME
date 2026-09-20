import {
  round2dp,
  lineTotal as sharedLineTotal,
  computeSubtotal as sharedSubtotal,
  invoiceTotal as sharedInvoiceTotal,
  invoiceRemaining as sharedInvoiceRemaining,
  type InvoiceLineData,
} from "@erp/shared";

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

/**
 * FIN-01: thin delegations to the single money authority in @erp/shared. The
 * preview cannot drift from the journaled subtotal because it runs the same
 * code the backend runs.
 */
function asSharedLine(l: InvoiceLineCalc): InvoiceLineData {
  return {
    quantityKg: l.quantityKg,
    pricePerKg: l.pricePerKg,
    discountAmount: l.discountAmount || 0,
  } as InvoiceLineData;
}

export function lineTotal(l: InvoiceLineCalc): number {
  return sharedLineTotal(asSharedLine(l));
}

export function invoiceSubtotal(inv: InvoiceCalc): number {
  return sharedSubtotal(inv.lines.map(asSharedLine));
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
  return sharedInvoiceTotal({
    lines: inv.lines.map(asSharedLine),
    discount: invoiceDiscount(inv),
    tax: invoiceTax(inv),
    shipping: invoiceShipping(inv),
  });
}

/**
 * FIN-08 / Phase 1: single remaining authority is `@erp/shared` (accounts for
 * returns). Frontend keeps `round2dp` so UI preview stays 2-dp consistent.
 */
export function invoiceRemaining(total: number, paid: number, returns: number = 0): number {
  return round2dp(sharedInvoiceRemaining(total, paid, returns));
}
