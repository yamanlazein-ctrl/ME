/**
 * Remediation Stage 2 — the archive schedule (D-02, D-04, D-05, D-16, D-17).
 *
 * The schedule is PURE: it takes "today" and the periods that are already archived, and says which
 * periods to archive. These tests pin the three rules that used to be wrong:
 *
 *   - a period is archived only AFTER it has ended (the old month-end ran on the last day, before
 *     that day's invoices were in the database);
 *   - EVERY uncovered period is archived, not just the previous one (the old catch-up was one
 *     month deep and then reported "already done" forever);
 *   - the second tick does NO work (the old worker re-exported 24 months every 6 hours).
 */
import { describe, it, expect } from "vitest";
import {
  planArchivePeriods,
  uncoveredPeriods,
  previousPeriod,
  periodsBack,
} from "../src/infrastructure/googledrive/archiveSchedule.js";

describe("period arithmetic", () => {
  it("steps back a month, including over a year boundary", () => {
    expect(previousPeriod("2026-11")).toBe("2026-10");
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(previousPeriod("2026-12")).toBe("2026-11");
  });

  it("lists periods oldest first", () => {
    expect(periodsBack("2026-03", 3)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("planArchivePeriods", () => {
  it("does NOT archive the current month while it is still open", () => {
    // 31 October: the month is not over, so its archive would miss that day's transactions.
    const plan = planArchivePeriods({ today: "2026-10-31", covered: [] });
    expect(plan.periods).not.toContain("2026-10");
    expect(plan.periods).toContain("2026-09");
  });

  it("archives the month that just ENDED, from the first day of the next one", () => {
    const plan = planArchivePeriods({ today: "2026-11-01", covered: [] });
    // The periods are oldest first, so the month that just ended is the LAST one.
    expect(plan.periods[plan.periods.length - 1]).toBe("2026-10");
  });

  it("archives EVERY uncovered period, not just the previous one", () => {
    // The desktop was off for three months: October, September and August are all missing, and
    // everything before them was archived long ago.
    const covered = periodsBack("2026-07", 21);
    const plan = planArchivePeriods({ today: "2026-11-01", covered, maxLookback: 24 });
    expect(plan.periods).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(plan.trigger).toBe("catchup");
  });

  it("does NO work when everything that should be archived already is", () => {
    // The second tick: the covered periods make the plan empty.
    const first = planArchivePeriods({ today: "2026-11-01", covered: [] });
    const second = planArchivePeriods({ today: "2026-11-01", covered: first.periods });
    expect(second.periods).toEqual([]);
    expect(uncoveredPeriods({ today: "2026-11-01", covered: first.periods })).toEqual([]);
  });

  it("archives only the periods that are missing when part of the history is covered", () => {
    const plan = planArchivePeriods({
      today: "2026-11-01",
      covered: ["2026-10"],
      maxLookback: 3,
    });
    expect(plan.periods).toEqual(["2026-08", "2026-09"]);
  });

  it("retries a gap left by a failed pass", () => {
    // 2026-09 failed, so it was never marked covered: the next tick must pick it up again, even
    // though the newer period is covered.
    const plan = planArchivePeriods({
      today: "2026-11-01",
      covered: ["2026-10", "2026-08"],
      maxLookback: 3,
    });
    expect(plan.periods).toEqual(["2026-09"]);
  });

  it("includes the current, still-open month for the manual trigger", () => {
    const plan = planArchivePeriods({ today: "2026-10-20", covered: [], includeCurrent: true });
    expect(plan.periods[plan.periods.length - 1]).toBe("2026-10");
    expect(plan.trigger).toBe("manual");
  });

  it("bounds the look-back so a fresh install does not walk the whole history", () => {
    const plan = planArchivePeriods({ today: "2026-10-20", covered: [], maxLookback: 24 });
    expect(plan.periods).toHaveLength(24);
    expect(plan.periods[0]).toBe("2024-10");
    expect(plan.periods[plan.periods.length - 1]).toBe("2026-09");
  });

  it("names the ordinary month-end case 'monthly'", () => {
    // Exactly one period is due: the month that just ended.
    const plan = planArchivePeriods({ today: "2026-11-01", covered: [], maxLookback: 1 });
    expect(plan.periods).toEqual(["2026-10"]);
    expect(plan.trigger).toBe("monthly");
  });
});
