// Spike S3 (research R8): PDF from the shared print builders. Shares a 3-line invoice and a 650-row statement.
import * as Sharing from "expo-sharing";
import type { ArchiveLeg } from "@erp/shared";
import { renderInvoiceHtml, renderStatementHtml } from "../print/renderHtml";
import { htmlToPdf } from "../print/toPdf";

const invoiceLines = [
  {
    fabric: "قطن",
    color: "أبيض",
    rollNo: "R-001",
    pieces: 2,
    quantityKg: 12.5,
    pricePerKg: 8.25,
    discountAmount: 0,
    lineTotal: 103.13,
  },
  {
    fabric: "حرير",
    color: "أحمر",
    rollNo: "R-002",
    pieces: 1,
    quantityKg: 7.75,
    pricePerKg: 10,
    discountAmount: 2.5,
    lineTotal: 75,
  },
  {
    fabric: "كتان",
    color: "أزرق",
    rollNo: "R-003",
    pieces: 3,
    quantityKg: 30,
    pricePerKg: 4.4,
    discountAmount: 0,
    lineTotal: 132,
  },
];

export async function runS3(): Promise<{
  invoiceMs: number;
  statementMs: number;
  statementRows: number;
}> {
  const t0 = Date.now();
  const invoice = await htmlToPdf(
    renderInvoiceHtml({
      header: {
        kind: "sale",
        number: "INV-2026-0042",
        date: "2026-01-15",
        partyName: "عميل تجريبي",
        currency: "USD",
        subtotal: 310.13,
        discount: 5,
        tax: 0,
        shipping: 2,
        total: 307.13,
        paid: 100,
        cancelled: false,
      },
      lines: invoiceLines,
    }),
  );
  const invoiceMs = Date.now() - t0;
  await Sharing.shareAsync(invoice, { mimeType: "application/pdf" });

  const legs: ArchiveLeg[] = Array.from({ length: 650 }, (_, i) => ({
    date: "2026-01-15",
    createdAt: `2026-01-15T10:${String(i % 60).padStart(2, "0")}:00.000000Z`,
    docRank: i % 2 ? 2 : 1,
    id: `id-${String(i).padStart(4, "0")}`,
    type: i % 2 ? "سند قبض" : "فاتورة بيع",
    reference: `REF-${i}`,
    description: "بيان تجريبي",
    debit: i % 2 ? 0 : 10,
    credit: i % 2 ? 10 : 0,
    status: "active" as const,
  }));
  const t1 = Date.now();
  const statement = await htmlToPdf(
    renderStatementHtml({
      partyName: "عميل تجريبي",
      partyKind: "customer",
      currency: "USD",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      opening: 100,
      legs,
    }),
  );
  const statementMs = Date.now() - t1;
  await Sharing.shareAsync(statement, { mimeType: "application/pdf" });
  return { invoiceMs, statementMs, statementRows: legs.length };
}
