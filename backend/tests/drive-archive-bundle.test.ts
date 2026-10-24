/**
 * Phase 3 — hash-first change detection. A document is re-rendered only when its source changed.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  decideRender,
  sourceHash,
  tally,
} from "../src/infrastructure/googledrive/archiveBundle.js";

const invoice = {
  number: "INV-0042",
  date: "2026-10-14",
  total: "290.00",
  lines: [{ roll: "R-1", kg: "100.00", price: "3.00" }],
};

describe("canonicalJson", () => {
  it("is the same for objects with keys in a different order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("drops undefined fields so they do not change the hash", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("sourceHash", () => {
  it("is stable for the same document", () => {
    expect(sourceHash(invoice)).toBe(sourceHash({ ...invoice }));
  });

  it("changes when a printed field changes", () => {
    expect(sourceHash({ ...invoice, total: "291.00" })).not.toBe(sourceHash(invoice));
    expect(
      sourceHash({ ...invoice, lines: [{ roll: "R-2", kg: "100.00", price: "3.00" }] }),
    ).not.toBe(sourceHash(invoice));
  });

  it("treats the money representation as part of the content: the string and the number hash differently", () => {
    // Callers must always pass money in the stored decimal-string form. This pins that the two forms are
    // NOT interchangeable, so a caller that mixes them is caught as a change instead of silently matching.
    expect(sourceHash({ total: "290.00" })).not.toBe(sourceHash({ total: 290 }));
  });
});

describe("decideRender", () => {
  const current = { sourceHash: "h1" };

  it("renders a document that has never been rendered", () => {
    expect(decideRender(current, null)).toEqual({ action: "render", reason: "new" });
  });

  it("skips an unchanged document", () => {
    expect(decideRender(current, { sourceHash: "h1", status: "done" })).toEqual({
      action: "skip",
      reason: "unchanged",
    });
  });

  it("re-renders a document whose source changed", () => {
    expect(decideRender(current, { sourceHash: "h0", status: "done" })).toEqual({
      action: "render",
      reason: "changed",
    });
  });

  it("retries a document whose last render failed, even if its source did not change", () => {
    expect(decideRender(current, { sourceHash: "h1", status: "failed" })).toEqual({
      action: "render",
      reason: "previous-failed",
    });
  });
});

describe("tally", () => {
  it("counts renders and skips for a pass", () => {
    const t = tally([
      { action: "render", reason: "new" },
      { action: "skip", reason: "unchanged" },
      { action: "skip", reason: "unchanged" },
    ]);
    expect(t).toEqual({ rendered: 1, skipped: 2, failed: 0 });
  });
});
