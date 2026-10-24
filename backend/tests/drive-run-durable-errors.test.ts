/**
 * A finished run's progress is read from its durable row once the live map has forgotten it (after
 * a restart). Its errors must come back too — the durable answer used to hard-code `errors: []`, so
 * a run that failed reported no error at all, which is the worst case for a failure.
 */
import { describe, it, expect } from "vitest";
import { durableErrors } from "../src/presentation/routes/drive.route.js";
import {
  encodeDetail,
  newRunProgress,
  recordError,
} from "../src/infrastructure/googledrive/archiveRuns.js";

describe("durable run errors", () => {
  it("reads the error list of a finished run from its stored progress", () => {
    const p = recordError(newRunProgress("manual", "2026-10"), "a.csv", "boom");
    expect(durableErrors(encodeDetail(p))).toEqual(["a.csv: boom"]);
  });

  it("returns the failure text of a run that failed outright", () => {
    expect(durableErrors("Error: DRIVE_NETWORK (0): timeout")).toEqual([
      "Error: DRIVE_NETWORK (0): timeout",
    ]);
  });

  it("is empty for a run without detail", () => {
    expect(durableErrors(null)).toEqual([]);
  });
});
