/**
 * One-line, human-readable reason for a failed server start-up.
 *
 * drizzle wraps the database's own error ("Failed query: <whole SQL text>") and keeps the real message —
 * e.g. the RAISE EXCEPTION text of a migration guard — in `cause`. The desktop shell can only show
 * server.log, so this is what gets written there instead of a screenful of SQL (or, worse, nothing).
 */
export function startupFailureReason(err: unknown): string {
  const cause = (err as { cause?: { message?: unknown } } | null | undefined)?.cause?.message;
  const raw =
    typeof cause === "string" && cause.trim()
      ? cause
      : err instanceof Error
        ? err.message
        : String(err);
  return raw.split("\n")[0]!.trim().slice(0, 500);
}
