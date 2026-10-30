import { shareDocument } from "./sendToCustomer";

/** Renders the invoice to a named PDF and opens the share sheet. */
export async function shareInvoicePdf(invoiceId: string) {
  return shareDocument({ type: "invoice", id: invoiceId });
}
