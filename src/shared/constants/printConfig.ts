/**
 * Shared print / company contact — single source of truth.
 *
 * Print header brand is always PRINT_BRAND_NAME (once).
 * Print header contact is ALWAYS FIXED_PRINT_FOOTER_LINES (verbatim),
 * each line on its own row. Never concatenated, never LTR-reversed,
 * never taken from settings.company (a corrupted settings write must
 * not scramble phones into the address).
 */
export const PRINT_BRAND_NAME = "Motard Fabrics Group";

/** Exact footer lines for every printed document (user-approved verbatim). */
export const FIXED_PRINT_FOOTER_LINES = [
  "سوريا - حلب - الشيخ نجار",
  "المدينة الصناعية - الفئة الأولى",
  "الصالة شارع النيل 629 64 26 021",
  "محمود كوكة 73 35 70 0933",
  "زكريا كوكة 44 76 88 0944",
] as const;

/**
 * Seeded defaults for settings.company when empty.
 * Kept in sync with FIXED_PRINT_FOOTER_LINES for the settings form / DB.
 */
export const FIXED_COMPANY_CONTACT = {
  address: [
    "سوريا - حلب - الشيخ نجار",
    "المدينة الصناعية - الفئة الأولى",
    "الصالة شارع النيل 629 64 26 021",
  ].join("\n"),
  landline: "021 26 64 629",
  phones: [
    { label: "محمود كوكة", phone: "0933 70 35 73" },
    { label: "زكريا كوكة", phone: "0944 88 76 44" },
  ],
} as const;

/** Single-line phone field for settings.company.phone (DB has one column). */
export function formatCompanyPhoneField(): string {
  const mobiles = FIXED_COMPANY_CONTACT.phones.map((p) => `${p.label}: ${p.phone}`).join(" · ");
  return `${FIXED_COMPANY_CONTACT.landline} · ${mobiles}`;
}

/**
 * Print header contact — always the fixed verbatim lines.
 * `company` is accepted for call-site compatibility but intentionally ignored
 * so a corrupted settings write can never reintroduce the wrong text or
 * duplicate a different format in the header.
 */
export function getCompanyContactLines(_company?: {
  address?: string | null;
  phone?: string | null;
}): string[] {
  return [...FIXED_PRINT_FOOTER_LINES];
}

/** Treat corrupted / placeholder company names as empty so fallbacks apply. */
export function sanitizeCompanyName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "";
  // Prior bad UTF-8 writes left literal ASCII '?' (one per Arabic codepoint).
  if (/^\?+(\s+\?+)*$/.test(n) || n.includes("\uFFFD")) return "";
  return n;
}

/** @deprecated Use getCompanyContactLines — kept for any stray imports. */
export function getOwnerFooterLine(): string {
  return FIXED_PRINT_FOOTER_LINES.join(" — ");
}
