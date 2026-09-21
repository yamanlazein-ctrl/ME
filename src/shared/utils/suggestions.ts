/**
 * Shared default-suggestion rule for every searchable/selectable field.
 *
 * When a picker is opened/focused with an EMPTY query it shows the
 * DEFAULT_SUGGESTION_COUNT most recent existing records. As soon as the user
 * types, each picker switches to its normal live search. Read-only: this never
 * creates or mutates records.
 */
export const DEFAULT_SUGGESTION_COUNT = 5;

/**
 * Newest-first slice of `items` (by `createdAt` when present). Items without a
 * usable `createdAt` keep their original relative order after dated ones.
 * Never mutates the input.
 */
export function recentSuggestions<T extends { createdAt?: string | number | Date | null }>(
  items: readonly T[],
  limit = DEFAULT_SUGGESTION_COUNT,
): T[] {
  const stamp = (t: T): number => {
    const v = t.createdAt;
    if (v === undefined || v === null) return Number.NEGATIVE_INFINITY;
    const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
    return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
  };
  return items
    .map((item, index) => ({ item, index, at: stamp(item) }))
    .sort((a, b) => (b.at === a.at ? a.index - b.index : b.at > a.at ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.item);
}
