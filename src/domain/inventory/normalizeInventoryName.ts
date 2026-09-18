/**
 * Normalize fabric/color names for client-side master lookup so entry invoices
 * reuse existing masters instead of creating near-duplicate rows.
 * (DB unique index remains exact; this only improves match-before-create.)
 */
export function normalizeInventoryName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670]/g, "") // Arabic diacritics
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
