/**
 * Print / PDF filename convention:
 *   [نوع المستند]_[اسم العميل أو المورد]_[رقم الفاتورة]_[التاريخ].pdf
 *
 * Sanitizes NTFS-illegal characters, trims length, and keeps Arabic.
 */

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_STEM = 120;

export const DOCUMENT_TYPE_AR: Record<string, string> = {
  sale: "فاتورة_خروج",
  entry: "فاتورة_دخول",
  print_send: "سند_إرسال_مطبعة",
  print_receive: "سند_استلام_مطبعة",
  statement: "كشف_حساب",
  receipt: "سند_قبض",
  payment: "سند_صرف",
  settlement: "تسوية_فواتير",
  return_sale: "مرتجع_بيع",
  return_entry: "مرتجع_دخول",
};

export function sanitizeFilenamePart(raw: string, fallback = "مستند"): string {
  const cleaned = (raw ?? "")
    .replace(ILLEGAL, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export function documentPdfStem(opts: {
  docType: string;
  partyName?: string | null;
  number?: string | null;
  date?: string | null;
}): string {
  const typeLabel = DOCUMENT_TYPE_AR[opts.docType] ?? sanitizeFilenamePart(opts.docType, "مستند");
  const party = sanitizeFilenamePart(opts.partyName ?? "", "بدون_اسم");
  const number = sanitizeFilenamePart(opts.number ?? "", "بدون_رقم");
  const datePart = (opts.date ?? new Date().toISOString().slice(0, 10)).replace(/[<>:"/\\|?*]/g, "-");
  const stem = `${typeLabel}_${party}_${number}_${datePart}`;
  return stem.length > MAX_STEM ? stem.slice(0, MAX_STEM) : stem;
}

export function uniqueFilename(stem: string, existing: Set<string>): string {
  const base = sanitizeFilenamePart(stem, "مستند");
  if (!existing.has(`${base}.pdf`.toLowerCase()) && !existing.has(base.toLowerCase())) {
    return base;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!existing.has(`${candidate}.pdf`.toLowerCase()) && !existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base}_${Date.now()}`;
}
