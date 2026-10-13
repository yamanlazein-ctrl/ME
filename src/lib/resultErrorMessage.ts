/**
 * The text to show for a failed `Result`'s error: its message, plus the first field detail the API
 * sent (`details: { field: ["…"] }`). Replaces five ad-hoc `(err as any)` readers, two of which could
 * show "undefined — …" (no message) or "[object Object]" (`toString()` of a plain object).
 */
export function resultErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error || fallback;
  if (!error || typeof error !== "object") return fallback;
  const e = error as { message?: unknown; details?: unknown };
  const message = typeof e.message === "string" && e.message ? e.message : undefined;
  const details =
    e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : undefined;
  const firstKey = details ? Object.keys(details)[0] : undefined;
  const first = firstKey !== undefined ? details![firstKey] : undefined;
  const firstDetail = Array.isArray(first) && typeof first[0] === "string" ? first[0] : undefined;
  if (firstDetail) return `${message ?? fallback} — ${firstDetail}`;
  return message ?? fallback;
}
