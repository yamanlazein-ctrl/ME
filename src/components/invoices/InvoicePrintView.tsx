import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import type { Invoice } from "@/domain/entities/Invoice";

/**
 * On-screen preview of the invoice print layout (used inside the tracking
 * dialog). The printed output goes through the unified print portal
 * (printDocument + [data-print-root]) — see invoices.tracking.tsx.
 */
export function InvoicePrintView({ invoice }: { invoice: Invoice }) {
  return <InvoicePrintDocument invoice={invoice} />;
}
