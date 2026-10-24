/**
 * Phase 2 / remediation Stage 2 — WHEN the archive runs, and WHICH periods it covers.
 *
 * Pure: no I/O, no clock. The caller supplies "today" and the periods that are already archived,
 * so the decision is unit-testable and reproducible.
 *
 * The rules it encodes (remediation D-02, D-04, D-05, D-17, D-18):
 *
 *   - A period is ARCHIVED only after it has ENDED. The archive for 2026-10 therefore runs in
 *     November, never on the evening of 31 October — a month-end archive taken on the last day
 *     would miss that day's invoices, vouchers and cashbox movements, which are not in the
 *     database yet.
 *   - EVERY uncovered period is archived, not just the previous one. A desktop that was off for
 *     three months archived one month and then reported "already done" forever.
 *   - The look-back is bounded (24 months), so a fresh install does not walk the whole history.
 *   - The manual trigger also archives the CURRENT (still open) month, so "upload now" puts the
 *     latest data up to date.
 */
import { periodKeyOf } from "./archiveCore.js";

/** `YYYY-MM` of a business date. */
export function periodOf(businessDate: string): string {
  return periodKeyOf(businessDate);
}

/** The period before `period` (`2026-10` → `2026-09`). */
export function previousPeriod(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) throw new Error(`INVALID_PERIOD_KEY: ${period}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** The `count` periods ending at `period`, OLDEST FIRST. */
export function periodsBack(period: string, count: number): string[] {
  const out: string[] = [];
  let p = period;
  for (let i = 0; i < count; i++) {
    out.unshift(p);
    p = previousPeriod(p);
  }
  return out;
}

export type ArchiveTrigger = "monthly" | "catchup" | "manual";

export type ArchivePlan = {
  /** The periods to archive, in the order they are archived. */
  periods: string[];
  /** Why this plan: the ordinary month-end, a backlog, or the operator's own request. */
  trigger: ArchiveTrigger;
};

export type PlanOptions = {
  /** The business date the decision is taken for (`YYYY-MM-DD`). */
  today: string;
  /** The periods that are already archived (a run for them finished). */
  covered: readonly string[];
  /** Also archive the current, still-open month (the manual trigger). */
  includeCurrent?: boolean;
  /** How far back to look for uncovered periods. */
  maxLookback?: number;
};

/** The periods that are still missing an archive, oldest first. */
export function uncoveredPeriods(opts: PlanOptions): string[] {
  const current = periodOf(opts.today);
  // The newest period that has ENDED is the previous one: the current month is still open.
  const newestClosed = previousPeriod(current);
  const maxLookback = opts.maxLookback ?? 24;
  const covered = new Set(opts.covered);
  const candidates = periodsBack(newestClosed, maxLookback); // oldest first
  // EVERY uncovered period is listed, not only the ones after the newest covered one: a pass that
  // failed half way leaves a gap, and that gap must be retried rather than reported as covered.
  return candidates.filter((p) => !covered.has(p));
}

/**
 * The periods this pass should archive, and why.
 *
 * The ordinary case is one period: the month that just ended. A backlog (the desktop was off) is
 * every month that was missed. The manual trigger adds the current, still-open month.
 */
export function planArchivePeriods(opts: PlanOptions): ArchivePlan {
  const current = periodOf(opts.today);
  const missing = uncoveredPeriods(opts);
  const includeCurrent = opts.includeCurrent === true;
  // Oldest first — the natural order of an archive — and the current (still open) month LAST,
  // because it is the newest. The LAST period is the one the pass publishes its progress on.
  const periods = includeCurrent ? [...missing, current] : missing;
  const trigger: ArchiveTrigger = includeCurrent
    ? "manual"
    : missing.length > 1
      ? "catchup"
      : "monthly";
  return { periods, trigger };
}
