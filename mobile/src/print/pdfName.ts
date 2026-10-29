/** ASCII file name for a document number (some chat apps mangle non-Latin names): "Invoice-INV-000012". */
export function pdfFileName(prefix: string, number: string): string {
  const safe = `${prefix}-${number}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return `${safe.replace(/^-|-$/g, "") || "Document"}.pdf`;
}
