/**
 * VERIFIED_REMEDIATION_PLAN TEMP-SYNC-01 — a revoked/refused device or a failing hub must not be
 * polled every 5 s forever: the periodic sync backs off exponentially to a 5-minute cap.
 */
import { describe, it, expect } from "vitest";
import { periodicBackoffMs } from "../useAutoSync";

describe("periodic sync backoff", () => {
  it("no pause while healthy, doubling after each failure, capped at 5 minutes", () => {
    expect(periodicBackoffMs(0)).toBe(0);
    expect(periodicBackoffMs(1)).toBe(10_000);
    expect(periodicBackoffMs(2)).toBe(20_000);
    expect(periodicBackoffMs(5)).toBe(160_000);
    expect(periodicBackoffMs(6)).toBe(300_000);
    expect(periodicBackoffMs(50)).toBe(300_000);
  });

  it("a day of refusals costs a few hundred calls, not ~17,000", () => {
    let t = 0;
    let calls = 0;
    let failures = 0;
    let pausedUntil = 0;
    for (; t < 86_400_000; t += 5_000) {
      if (t < pausedUntil) continue;
      calls += 1;
      failures += 1;
      pausedUntil = t + periodicBackoffMs(failures);
    }
    expect(calls).toBeLessThan(300);
  });
});
