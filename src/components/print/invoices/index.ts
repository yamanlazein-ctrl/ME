/**
 * Per-type invoice print templates — shared visual system, but each
 * invoice type shows its own real fields (no field is hidden to make
 * the table prettier).
 *
 * Use `EntryInvoicePrint` / `SaleInvoicePrint` / `ReturnInvoicePrint`
 * directly from a route. The legacy `InvoicePrintDocument` in the
 * parent folder is kept as a thin dispatcher for old callers.
 */
import { EntryInvoicePrint } from "./EntryInvoicePrint";
import { SaleInvoicePrint } from "./SaleInvoicePrint";
import { ReturnInvoicePrint } from "./ReturnInvoicePrint";

export { EntryInvoicePrint, SaleInvoicePrint, ReturnInvoicePrint };
export * from "./visibility";
