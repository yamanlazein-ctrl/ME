export type InvoiceLineData = {
  id: string;
  fabricId: string;
  colorId: string;
  rollId: string;
  quantityKg: number;
  pieces?: number;
  pricePerKg: number;
  discountAmount: number;
  note?: string;
};

export type InvoiceData = {
  id: string;
  tenantId: string;
  number: string;
  reference?: string | null;
  type: "entry" | "sale" | "return";
  date: string;
  partyId: string;
  partyType: "customer" | "supplier";
  currency: string;
  status: "draft" | "active" | "cancelled";
  lines: readonly InvoiceLineData[];
  discount?: number;
  tax?: number;
  shipping?: number;
  notes?: string;
  paid?: number;
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  orderId?: string;
  createdAt: string;
  createdBy: string;
  version: number;
  cancelledAt?: string | null;
};

export function lineTotal(line: InvoiceLineData): number {
  const gross = line.quantityKg * line.pricePerKg;
  return Math.max(0, Math.round(gross - (line.discountAmount ?? 0)));
}

export function computeSubtotal(lines: readonly InvoiceLineData[]): number {
  return lines.reduce((s, l) => s + lineTotal(l), 0);
}

export function invoiceTotal(data: Pick<InvoiceData, "lines" | "discount" | "tax" | "shipping">): number {
  const subtotal = computeSubtotal(data.lines);
  return subtotal - (data.discount ?? 0) + (data.tax ?? 0) + (data.shipping ?? 0);
}

export function invoiceLineSubtotal(lines: readonly InvoiceLineData[]): number {
  return computeSubtotal(lines);
}
