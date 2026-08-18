/**
 * Backward-compatible dispatcher. Existing routes import this name —
 * now it just picks the right per-type template based on `invoice.type`.
 *
 * All field rendering is done by the per-type template; this file
 * exists only so callers don't need to import the dispatcher directly.
 */
import type { Invoice } from "@/domain/entities/Invoice";
import { EntryInvoicePrint } from "./invoices/EntryInvoicePrint";
import { SaleInvoicePrint } from "./invoices/SaleInvoicePrint";

type Props = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
};

export function InvoicePrintDocument({ invoice, totalPages, pageNumber }: Props) {
  // Note: Invoice entity with type="return" is rare (most returns use
  // the Return entity). The legacy route pages still pass such invoices
  // here, so we map "return" to SaleInvoicePrint (the customer-facing
  // shape — return-to-supplier flows use the Return entity's own template).
  if (invoice.type === "sale") {
    return (
      <SaleInvoicePrint
        invoice={invoice}
        totalPages={totalPages}
        pageNumber={pageNumber}
      />
    );
  }
  // entry + return
  return (
    <EntryInvoicePrint
      invoice={invoice}
      totalPages={totalPages}
      pageNumber={pageNumber}
    />
  );
}
