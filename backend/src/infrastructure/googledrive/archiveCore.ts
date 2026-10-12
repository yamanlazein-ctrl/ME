/**
 * Pure core of the Google Drive monthly archive: folder layout, Arabic month
 * formatting, deterministic filenames, and the stable-key idempotency contract.
 * No I/O — everything here is unit-testable without Google credentials.
 */

/** The archive root, exactly as specified (Arabic name preserved). */
export const DRIVE_ROOT_NAME = "Motard ERP - أرشيف النظام";

/** Gregorian Arabic month names, indexed 1–12. */
const ARABIC_MONTHS = [
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

/**
 * Document-category sections, mapped ONLY to modules that exist in the ERP
 * (src/routes/*, backend routes — verified 2026-10). Keep in sync with the
 * exporter registry; a section with no exporter must never be listed.
 */
export const SECTIONS = {
  salesInvoices: "فواتير البيع",
  purchaseInvoices: "فواتير الشراء",
  returns: "المرتجعات",
  orders: "الطلبيات",
  inventory: "المخزون والجرد",
  payments: "المقبوضات والمدفوعات",
  cashboxExpenses: "الصندوق والمصروفات",
  statements: "كشوفات الحسابات",
  reports: "التقارير",
  attachments: "المرفقات",
  monthClose: "إغلاق الشهر",
  dbBackups: "نسخ احتياطية لقاعدة البيانات",
} as const;

export type SectionKey = keyof typeof SECTIONS;

export type Section = {
  key: SectionKey;
  label: string;
  /** MIME type this section's exporter produces. */
  mime: string;
  fileExt: string;
};

export const SECTION_LIST: Section[] = (
  Object.entries(SECTIONS) as Array<[SectionKey, string]>
).map(([key, label]) => ({
  key,
  label,
  mime: "text/csv;charset=utf-8",
  fileExt: "csv",
}));

/** A document/backup upload targets `sections[...]` by key; labels resolve below. */
export function sectionLabel(key: SectionKey): string {
  return SECTIONS[key];
}

/** `2026-10` → `2026-10 — أكتوبر` (em dash, sortable prefix, Arabic month). */
export function monthFolderName(periodKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) throw new Error(`INVALID_PERIOD_KEY: ${periodKey}`);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`INVALID_PERIOD_KEY: ${periodKey}`);
  return `${m[1]}-${m[2]} — ${ARABIC_MONTHS[month - 1]}`;
}

/** Local business date → `YYYY-MM` period key (calendar arithmetic, no UTC drift). */
export function periodKeyOf(businessDate: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(businessDate);
  if (!m) throw new Error(`INVALID_BUSINESS_DATE: ${businessDate}`);
  return `${m[1]}-${m[2]}`;
}

/** Local business date → `YYYY` year folder. */
export function yearOf(businessDate: string): string {
  return periodKeyOf(businessDate).slice(0, 4);
}

/** Windows-forbidden + control characters; Arabic and digits are preserved. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** Sanitize one path segment for Drive/Windows: illegal chars → space, trimmed, length-capped. */
export function sanitizeSegment(raw: string, maxLen = 120): string {
  const cleaned = raw.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "بدون-اسم";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}

export type FileStemInput = {
  /** Business date, `YYYY-MM-DD` — leads the name so Drive's newest-first sort works. */
  businessDate: string;
  /** Stable document identifier (document number or id). */
  documentId: string;
  /** Business/customer name when appropriate (already optional by contract). */
  partyName?: string | null;
};

/** `{date}_{id}_{party}.csv` — deterministic, newest-first sortable. */
export function archiveFileName(input: FileStemInput, ext: string): string {
  const date = sanitizeSegment(input.businessDate, 10);
  const id = sanitizeSegment(input.documentId, 60);
  const party = input.partyName ? sanitizeSegment(input.partyName, 40) : "";
  const stem = party ? `${date}_${id}_${party}` : `${date}_${id}`;
  return `${stem}.${ext.replace(/^\./, "")}`;
}

/** True when `candidate` differs only by a trailing `-N` collision suffix. */
export function isCollisionSuffixOf(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([2-9]\\d*)$`).exec(
    candidate,
  );
  return m !== null;
}

/**
 * The idempotency key. Two events (double-fire, second device, retry of an
 * interrupted export) collapse into ONE queue row when the content hash is
 * equal; a content change produces a new key and therefore a new revision.
 */
export function stableKeyOf(
  entityType: string,
  entityId: string,
  periodKey: string,
  section: string,
  contentSha256: string,
): string {
  // Inline sha256 here would duplicate node:crypto into pure land; callers
  // hash content and pass it in — this joins the identity parts.
  return [entityType, entityId, periodKey, section, contentSha256].join("|");
}
