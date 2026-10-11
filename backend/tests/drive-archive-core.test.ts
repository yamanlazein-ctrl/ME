/**
 * Pure archive-core tests: month formatting, period assignment, filename
 * sanitization/determinism, and the stable-key idempotency contract.
 */
import { describe, it, expect } from "vitest";
import {
  DRIVE_ROOT_NAME,
  monthFolderName,
  periodKeyOf,
  yearOf,
  sanitizeSegment,
  archiveFileName,
  stableKeyOf,
  SECTION_LIST,
} from "../src/infrastructure/googledrive/archiveCore.js";

describe("month folder names", () => {
  it("formats every Arabic month correctly", () => {
    expect(monthFolderName("2026-01")).toBe("2026-01 — يناير");
    expect(monthFolderName("2026-10")).toBe("2026-10 — أكتوبر");
    expect(monthFolderName("2026-12")).toBe("2026-12 — ديسمبر");
  });

  it("sorts chronologically by the numeric prefix", () => {
    const names = ["2026-11", "2025-03", "2026-01", "2026-02"].map(monthFolderName);
    expect([...names].sort()).toEqual(["2025-03 — مارس", "2026-01 — يناير", "2026-02 — فبراير", "2026-11 — نوفمبر"]);
  });

  it("crosses the December→January year boundary", () => {
    expect(monthFolderName("2026-12")).toBe("2026-12 — ديسمبر");
    expect(monthFolderName("2027-01")).toBe("2027-01 — يناير");
  });

  it("rejects malformed period keys", () => {
    expect(() => monthFolderName("2026-13")).toThrow(/INVALID_PERIOD_KEY/);
    expect(() => monthFolderName("october")).toThrow(/INVALID_PERIOD_KEY/);
    expect(() => monthFolderName("2026-10x")).toThrow(/INVALID_PERIOD_KEY/);
  });
});

describe("business-date → period/year", () => {
  it("uses the business date, not the upload date", () => {
    expect(periodKeyOf("2026-09-30")).toBe("2026-09");
    expect(periodKeyOf("2026-10-01")).toBe("2026-10");
    expect(yearOf("2026-09-30")).toBe("2026");
  });

  it("rejects impossible dates", () => {
    expect(() => periodKeyOf("not-a-date")).toThrow(/INVALID_BUSINESS_DATE/);
  });
});

describe("sanitizeSegment", () => {
  it("preserves Arabic and digits", () => {
    expect(sanitizeSegment("شركة الأنسجة 2026")).toBe("شركة الأنسجة 2026");
  });

  it("replaces Windows-forbidden characters", () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  it("drops control characters", () => {
    expect(sanitizeSegment("inv\u00001\u001f2")).toBe("inv 1 2");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeSegment("  a   b  ")).toBe("a b");
  });

  it("caps length and never returns empty", () => {
    expect(sanitizeSegment("x".repeat(200)).length).toBeLessThanOrEqual(120);
    expect(sanitizeSegment("///")).toBe("بدون-اسم");
  });
});

describe("archiveFileName", () => {
  it("is deterministic and sortable by business date", () => {
    const a = archiveFileName({ businessDate: "2026-10-05", documentId: "INV-1012", partyName: "مؤسسة النور" }, "csv");
    const b = archiveFileName({ businessDate: "2026-10-05", documentId: "INV-1012", partyName: "مؤسسة النور" }, "csv");
    expect(a).toBe(b);
    expect(a).toBe("2026-10-05_INV-1012_مؤسسة النور.csv");
  });

  it("sorts newest-first with a plain string sort", () => {
    const names = [
      archiveFileName({ businessDate: "2026-10-01", documentId: "1" }, "csv"),
      archiveFileName({ businessDate: "2026-10-09", documentId: "2" }, "csv"),
      archiveFileName({ businessDate: "2026-10-05", documentId: "3" }, "csv"),
    ];
    expect([...names].sort().reverse()[0]).toContain("2026-10-09");
  });

  it("omits empty party names and sanitizes hostile ones", () => {
    expect(archiveFileName({ businessDate: "2026-10-05", documentId: "X" }, "csv")).toBe("2026-10-05_X.csv");
    const hostile = archiveFileName({ businessDate: "2026-10-05", documentId: "X", partyName: "a/b|c" }, "csv");
    expect(hostile).not.toMatch(/[/|]/);
  });

  it("normalizes the extension dot", () => {
    expect(archiveFileName({ businessDate: "2026-10-05", documentId: "X" }, ".pdf")).toBe("2026-10-05_X.pdf");
  });
});

describe("stableKey idempotency", () => {
  it("collapses duplicate events with identical content", () => {
    const k1 = stableKeyOf("invoice", "id-1", "2026-10", "salesInvoices", "hash-a");
    const k2 = stableKeyOf("invoice", "id-1", "2026-10", "salesInvoices", "hash-a");
    expect(k1).toBe(k2);
  });

  it("separates different content, sections, periods and entities", () => {
    const base = stableKeyOf("invoice", "id-1", "2026-10", "salesInvoices", "hash-a");
    expect(stableKeyOf("invoice", "id-1", "2026-10", "salesInvoices", "hash-b")).not.toBe(base); // edited document
    expect(stableKeyOf("invoice", "id-1", "2026-10", "returns", "hash-a")).not.toBe(base);
    expect(stableKeyOf("invoice", "id-1", "2026-09", "salesInvoices", "hash-a")).not.toBe(base);
    expect(stableKeyOf("invoice", "id-2", "2026-10", "salesInvoices", "hash-a")).not.toBe(base);
  });
});

describe("section registry", () => {
  it("contains only ERP-supported sections, all with unique labels", () => {
    const labels = SECTION_LIST.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(SECTION_LIST.length).toBe(12);
  });

  it("keeps the Drive root name exactly as specified", () => {
    expect(DRIVE_ROOT_NAME).toBe("Motard ERP - أرشيف النظام");
  });
});
