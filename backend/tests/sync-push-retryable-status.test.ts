/**
 * Sync audit #1 (critical): after a hub upgrade the hub answers 426 to an older app. 426 was a "permanent
 * rejection", so the device marked every unit of the batch rejected and rolled back (cancelled) its own unsynced
 * invoices, vouchers and returns. A wrong hub URL (404) or a proxy's body limit (413) did the same.
 */
import { describe, expect, it } from "vitest";
import { isRetryablePushStatus } from "../src/application/use-cases/sync/syncUseCases.js";

describe("push: statuses that say nothing about the unit keep it pending", () => {
  it("426, 404 and 413 are retried, never a rejection that rolls the document back", () => {
    for (const s of [426, 404, 413]) expect(isRetryablePushStatus(s)).toBe(true);
  });
  it("the transient statuses stay retryable", () => {
    for (const s of [401, 403, 408, 425, 429, 500, 502, 503])
      expect(isRetryablePushStatus(s)).toBe(true);
  });
  it("a genuine verdict on the unit stays permanent", () => {
    for (const s of [400, 410, 422]) expect(isRetryablePushStatus(s)).toBe(false);
  });
});
