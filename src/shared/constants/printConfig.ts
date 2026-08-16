/**
 * Shared print configuration — read from ONE place, never hardcoded in
 * individual print documents. This is the single source of truth for
 * owner/shop contact info that appears on every printed document.
 *
 * NOTE: This is a constant for now. In the future it can be moved to
 * company settings (Settings → Company) so the user can edit it from UI.
 */
export const OWNER_CONTACT = {
  name: "محمود كوكه",
  phone: "0933703573",
} as const;

/** Formatted footer line used by every print document. */
export function getOwnerFooterLine(): string {
  return `${OWNER_CONTACT.name} — ${OWNER_CONTACT.phone}`;
}
