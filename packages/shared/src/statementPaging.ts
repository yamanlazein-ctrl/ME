/**
 * Bug #8 — statement paging arithmetic shared by the client and the server.
 *
 * Lives in `@erp/shared` because BOTH sides need the same rule and the two
 * must never disagree:
 *
 *   - the server reports the true `totalPages` for the window it actually
 *     queried, and returns an EMPTY page when the requested page is past the
 *     end (it must never silently serve the last page under the requested
 *     number — that mislabels every row's `seq` and running balance);
 *   - the client then clamps the page it DISPLAYS, so a stale index such as
 *     100 left over from a long statement can never be rendered against a
 *     four-invoice party.
 *
 * The two halves are asserted together in backend/tests/statement-page-clamp.test.ts.
 */

/**
 * The page index that may actually be displayed, given the true page count.
 *
 * Clamps into `[0, totalPages - 1]`. `totalPages` is treated as at least 1, so
 * an unknown or absent count (first paint) yields page 0 rather than a crash.
 */
export function clampStatementPageIndex(
  requested: number,
  totalPages: number | undefined,
): number {
  const max = Math.max(0, (totalPages ?? 1) - 1);
  const page = Math.floor(Number.isFinite(requested) ? requested : 0);
  return Math.min(Math.max(0, page), max);
}
