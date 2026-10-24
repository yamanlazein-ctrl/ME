import { describe, it, expect } from "vitest";
import {
  advance,
  decodeDetail,
  encodeDetail,
  finalState,
  newRunProgress,
  percent,
  recordError,
  requestCancel,
  setTotal,
} from "../src/infrastructure/googledrive/archiveRuns.js";

describe("run progress", () => {
  it("starts at zero and reports 100% when there is nothing to do", () => {
    const p = newRunProgress("manual", "2026-10");
    expect(percent(p)).toBe(100);
    expect(setTotal(p, 0).done).toBe(0);
  });

  it("advances one file at a time and never passes the total", () => {
    let p = setTotal(newRunProgress("monthly", "2026-10"), 2);
    p = advance(p, "a.pdf");
    p = advance(p, "b.pdf");
    p = advance(p, "c.pdf"); // a stray extra event must not overshoot
    expect(p.done).toBe(2);
    expect(percent(p)).toBe(100);
    expect(p.currentFile).toBe("c.pdf");
  });

  it("rejects an impossible total", () => {
    expect(() => setTotal(newRunProgress("manual", "2026-10"), -1)).toThrow(/RUN_TOTAL_INVALID/);
    expect(() => setTotal(newRunProgress("manual", "2026-10"), 1.5)).toThrow(/RUN_TOTAL_INVALID/);
  });

  it("shrinking the total below progress caps progress at the new total", () => {
    let p = setTotal(newRunProgress("manual", "2026-10"), 5);
    p = advance(advance(advance(p, "a"), "b"), "c");
    expect(setTotal(p, 2).done).toBe(2);
  });
});

describe("final state", () => {
  it("is done when every file succeeded", () => {
    const p = setTotal(newRunProgress("monthly", "2026-10"), 3);
    expect(finalState(advance(advance(advance(p, "a"), "b"), "c"), 3)).toBe("done");
  });

  it("is partial when some files failed and some succeeded", () => {
    let p = setTotal(newRunProgress("monthly", "2026-10"), 3);
    p = recordError(p, "a.pdf", "PrintToPdf failed");
    p = advance(advance(p, "b"), "c");
    expect(finalState(p, 3)).toBe("partial");
  });

  it("is failed when every attempted file failed", () => {
    let p = setTotal(newRunProgress("monthly", "2026-10"), 2);
    p = recordError(recordError(p, "a", "x"), "b", "y");
    expect(finalState(p, 2)).toBe("failed");
  });

  it("is cancelled when cancellation was requested", () => {
    const p = requestCancel(setTotal(newRunProgress("manual", "2026-10"), 2), "running");
    expect(finalState(p, 2)).toBe("cancelled");
  });

  it("is done for an empty run", () => {
    expect(finalState(newRunProgress("manual", "2026-10"), 0)).toBe("done");
  });
});

describe("cancellation", () => {
  it("can be requested while running", () => {
    expect(requestCancel(newRunProgress("manual", "2026-10"), "running").cancelRequested).toBe(
      true,
    );
  });

  it("is refused once the run has finished", () => {
    expect(() => requestCancel(newRunProgress("manual", "2026-10"), "done")).toThrow(
      /RUN_NOT_RUNNING/,
    );
    expect(() => requestCancel(newRunProgress("manual", "2026-10"), "cancelled")).toThrow(
      /RUN_NOT_RUNNING/,
    );
  });
});

describe("live run registry", async () => {
  const live = await import("../src/infrastructure/googledrive/archiveRuns.js");

  it("reports a started run as running with its progress", () => {
    live.startLiveRun("r-1", setTotal(newRunProgress("manual", "2026-10"), 3));
    expect(live.getLiveRun("r-1")?.state).toBe("running");
    expect(live.getLiveRun("r-1")?.progress.total).toBe(3);
  });

  it("cancels a running run and refuses to cancel one that finished", () => {
    live.startLiveRun("r-2", setTotal(newRunProgress("manual", "2026-10"), 3));
    expect(live.cancelLiveRun("r-2")).toBe(true);
    expect(live.getLiveRun("r-2")?.progress.cancelRequested).toBe(true);

    live.startLiveRun("r-3", newRunProgress("manual", "2026-10"));
    live.finishLiveRun("r-3", "done", newRunProgress("manual", "2026-10"));
    expect(live.cancelLiveRun("r-3")).toBe(false);
    expect(live.getLiveRun("r-3")?.state).toBe("done");
  });

  it("returns null for an unknown run and refuses to cancel it", () => {
    expect(live.getLiveRun("nope")).toBeNull();
    expect(live.cancelLiveRun("nope")).toBe(false);
  });

  it("keeps running runs when older finished runs are pruned", () => {
    live.startLiveRun("keep-me", setTotal(newRunProgress("monthly", "2026-10"), 1));
    for (let i = 0; i < 30; i++) {
      live.startLiveRun(`old-${i}`, newRunProgress("manual", "2026-10"));
      live.finishLiveRun(`old-${i}`, "done", newRunProgress("manual", "2026-10"));
    }
    expect(live.getLiveRun("keep-me")?.state).toBe("running");
  });
});

describe("detail round-trip", () => {
  it("restores the progress it stored", () => {
    let p = setTotal(newRunProgress("catchup", "2026-09"), 4);
    p = advance(p, "x.pdf");
    const back = decodeDetail(encodeDetail(p), newRunProgress("manual", "2000-01"));
    expect(back).toEqual(p);
  });

  it("falls back safely when the stored detail is corrupt or empty", () => {
    const fb = newRunProgress("manual", "2026-10");
    expect(decodeDetail("{not json", fb)).toEqual(fb);
    expect(decodeDetail(null, fb)).toEqual(fb);
  });

  it("drops malformed fields instead of trusting them", () => {
    const back = decodeDetail(
      JSON.stringify({ done: "lots", total: 3, errors: [1, "ok"] }),
      newRunProgress("manual", "2026-10"),
    );
    expect(back.done).toBe(0);
    expect(back.total).toBe(3);
    expect(back.errors).toEqual(["ok"]);
  });
});
