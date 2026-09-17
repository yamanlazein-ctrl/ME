/**
 * Backward-compatible dispatcher. Existing routes import this name —
 * now it just picks the right per-type template based on `invoice.type`.
 */
import { Fragment } from "react";
import type { Invoice } from "@/domain/entities/Invoice";
import { EntryInvoicePrint } from "./invoices/EntryInvoicePrint";
import { SaleInvoicePrint } from "./invoices/SaleInvoicePrint";
import { PrintPageBreak } from "./PrintDocument";
import { chunkArray, INVOICE_LINES_PER_PRINT_PAGE } from "@/shared/utils/printPagination";

type Props = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
};

export function InvoicePrintDocument({ invoice, totalPages, pageNumber }: Props) {
  const explicitPage = pageNumber != null && totalPages != null;

  if (explicitPage) {
    return renderPage(invoice, pageNumber, totalPages);
  }

  const chunks = chunkArray(invoice.lines, INVOICE_LINES_PER_PRINT_PAGE);
  if (chunks.length <= 1) {
    return renderPage(invoice, 1, 1);
  }

  return (
    <>
      {chunks.map((lines, i) => (
        <Fragment key={`${invoice.id}-p${i + 1}`}>
          {i > 0 && <PrintPageBreak />}
          {renderPage(invoice, i + 1, chunks.length, lines)}
        </Fragment>
      ))}
    </>
  );
}

function renderPage(
  invoice: Invoice,
  page: number,
  pages: number,
  linesOverride?: Invoice["lines"],
) {
  const props = {
    invoice,
    pageNumber: page,
    totalPages: pages,
    linesOverride,
  };
  if (invoice.type === "sale") {
    return <SaleInvoicePrint {...props} />;
  }
  return <EntryInvoicePrint {...props} />;
}
