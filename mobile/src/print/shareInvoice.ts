import * as Sharing from "expo-sharing";
import { getApp } from "../core/appRuntime";
import { loadInvoiceView, toPrintData } from "../core/invoiceView";
import { renderInvoiceHtml } from "./renderHtml";
import { htmlToPdf } from "./toPdf";

/** Renders the invoice to PDF with the shared archive builders and opens the system share sheet. */
export async function shareInvoicePdf(invoiceId: string): Promise<void> {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  const view = await loadInvoiceView(app.phone, invoiceId);
  if (!view) throw new Error("الفاتورة غير موجودة");
  const uri = await htmlToPdf(renderInvoiceHtml(toPrintData(view)));
  await Sharing.shareAsync(uri, { mimeType: "application/pdf" });
}
