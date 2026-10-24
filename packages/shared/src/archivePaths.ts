/**
 * Phase 2 — one naming engine for the local desktop archive AND the Google Drive archive.
 *
 * Pure functions only (no I/O). Both the backend (Drive) and the frontend/shell (local folders) import
 * this module, so the two copies can never disagree.
 *
 * Hierarchy (Drive and local, identical):
 *   [اسم الشركة] - أرشيف النظام / YYYY / YYYY-MM — <Arabic month> / <category> / <file>
 *
 * Note: `documentFilename.ts` is the separate, older PRINT naming convention (underscored). It is not
 * changed here; this module owns the archive layout only.
 */

/**
 * The fixed archive categories. Keys are stable identifiers; labels are the folder names.
 *
 * `print_jobs` exists because a print job (fabric sent to / received back from the printing
 * factory) is a real archived document that moves stock — it is neither an invoice nor a statement.
 * The Phase 2 category set dropped it, which silently stopped archiving print_send and
 * print_receive documents (the shell refused them as "unknown document type").
 */
export const ARCHIVE_CATEGORIES = {
  entry_invoices: "فواتير الدخول",
  sale_invoices: "فواتير الخروج",
  returns: "المرتجعات",
  print_jobs: "إرساليات واستلامات الطباعة",
  statements: "كشوف الحسابات",
  cashbox: "الصندوق والتقارير",
  system_backups: "نسخ النظام الاحتياطية",
} as const;

export type ArchiveCategory = keyof typeof ARCHIVE_CATEGORIES;

export const ARCHIVE_CATEGORY_KEYS = Object.keys(ARCHIVE_CATEGORIES) as ArchiveCategory[];

/** Gregorian Arabic month names, indexed 1–12. */
export const ARABIC_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
] as const;

/** Windows-forbidden and control characters. Arabic, digits and spaces are kept. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_SEGMENT = 120;
const MAX_FILE_STEM = 150;

/** Sanitize one path segment: illegal characters become a space, whitespace collapses, length capped. */
export function sanitizeSegment(raw: string, maxLen = MAX_SEGMENT): string {
  const cleaned = (raw ?? "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "بدون-اسم";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}

/** `[اسم الشركة] - أرشيف النظام`. A blank company name falls back to the product name. */
export function companyFolderName(companyName: string | null | undefined): string {
  const name = sanitizeSegment(companyName ?? "", 100);
  const base = name === "بدون-اسم" ? "Motard ERP" : name;
  return `${base} - أرشيف النظام`;
}

/** `YYYY` from a business date `YYYY-MM-DD` (or `YYYY-MM`). Throws on anything else. */
export function yearFolder(businessDate: string): string {
  return periodOf(businessDate).slice(0, 4);
}

/** `YYYY-MM — <Arabic month>` from a business date or period key. */
export function monthFolder(businessDate: string): string {
  const period = periodOf(businessDate);
  const month = Number(period.slice(5, 7));
  return `${period} — ${ARABIC_MONTHS[month - 1]}`;
}

/** The fixed Arabic folder name for a category. */
export function categoryFolder(category: ArchiveCategory): string {
  const label = ARCHIVE_CATEGORIES[category];
  if (!label) throw new Error(`UNKNOWN_ARCHIVE_CATEGORY: ${String(category)}`);
  return label;
}

/** `YYYY-MM` from `YYYY-MM-DD` or `YYYY-MM`. Calendar-checked. */
function periodOf(businessDate: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(businessDate ?? "");
  if (!m) throw new Error(`INVALID_BUSINESS_DATE: ${String(businessDate)}`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`INVALID_BUSINESS_DATE: ${businessDate}`);
  return `${m[1]}-${m[2]}`;
}

export type DocumentFileMeta = {
  /** Business date of the document, `YYYY-MM-DD`. */
  businessDate: string;
  /** Creation time `HH:mm` (24h). Taken from the document's createdAt, never the render time. */
  time: string;
  /** Short type code, e.g. `sale`, `entry`, `return_sale`, `statement_customer`, `cashbox`. */
  docType: string;
  /** Document number or stable code. */
  code: string;
  /** Party (customer/supplier) name, or empty for documents without one. */
  partyName?: string | null;
  /** File extension without the dot. */
  ext: string;
};

/**
 * `YYYY-MM-DD_HH-mm_<type>_<code>_<party>.<ext>` — sorts newest-first with a plain string sort when
 * reversed. Deterministic: the same document always gets the same name.
 */
export function documentFileName(meta: DocumentFileMeta): string {
  const date = meta.businessDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`INVALID_BUSINESS_DATE: ${date}`);
  const time = /^\d{2}:\d{2}$/.test(meta.time) ? meta.time.replace(":", "-") : "00-00";
  const type = sanitizeSegment(meta.docType, 30);
  const code = sanitizeSegment(meta.code, 40);
  const party = meta.partyName ? sanitizeSegment(meta.partyName, 40) : "";
  const stem = [date + "_" + time, type, code, party].filter(Boolean).join("_");
  const capped = stem.length > MAX_FILE_STEM ? stem.slice(0, MAX_FILE_STEM).trimEnd() : stem;
  return `${capped}.${meta.ext.replace(/^\./, "")}`;
}

/**
 * The stable identity of one archived document. Stored in Drive `appProperties.motardKey` so an edited
 * document updates its existing Drive file (matched by key) instead of creating a duplicate. The name
 * is for people; this key is for the machine. It contains no content hash on purpose: a content change
 * must update the same file, not create a new one.
 */
export function appKey(input: { tenantId: string; docType: string; documentId: string }): string {
  const parts = [input.tenantId, input.docType, input.documentId].map((p) => p.trim());
  if (parts.some((p) => p === "")) throw new Error("APP_KEY_PART_EMPTY");
  return parts.join("|");
}
