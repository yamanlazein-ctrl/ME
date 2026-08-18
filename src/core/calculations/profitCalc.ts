import { lineTotal } from "./invoiceCalc";

export type InvoiceForProfit = {
  type: string;
  status: string;
  lines: { rollId?: string; quantityKg: number; pricePerKg: number; discountAmount: number }[];
};

export function calculateCOGS(invoice: InvoiceForProfit, getRollPrice: (rollId: string) => number): number {
  return invoice.lines.reduce((sum, line) => {
    if (!line.rollId) return sum;
    const price = getRollPrice(line.rollId);
    if (!price) return sum;
    return sum + price * line.quantityKg;
  }, 0);
}

export function calculateProfit(
  salesInvoices: InvoiceForProfit[],
  getRollPrice: (rollId: string) => number,
): {
  totalSales: number;
  totalCOGS: number;
  profit: number;
  marginPercent: number;
} {
  let totalSales = 0;
  let totalCOGS = 0;
  for (const inv of salesInvoices) {
    if (inv.type !== "sale" || inv.status === "cancelled") continue;
    totalSales += inv.lines.reduce((s, l) => s + lineTotal(l), 0);
    totalCOGS += calculateCOGS(inv, getRollPrice);
  }
  const profit = totalSales - totalCOGS;
  const marginPercent = totalSales > 0 ? (profit / totalSales) * 100 : 0;
  return { totalSales, totalCOGS, profit, marginPercent };
}
