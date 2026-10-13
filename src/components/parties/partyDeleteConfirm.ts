/** The phrase the operator must type before the delete button enables. */
export const PARTY_DELETE_CONFIRM_PHRASE = "نعم، متأكد";

/** Accepts the phrase with either comma (، or ,) and surrounding spaces. */
export function isPartyDeleteConfirmed(typed: string): boolean {
  return typed.trim().replace(/\s+/g, " ").replace(/,/g, "،") === PARTY_DELETE_CONFIRM_PHRASE;
}
