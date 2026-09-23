/**
 * REPAIR-006 — escape LIKE/ILIKE metacharacters so user input cannot widen matches.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Build `%term%` for ILIKE with escaped metacharacters. */
export function likeContains(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}
