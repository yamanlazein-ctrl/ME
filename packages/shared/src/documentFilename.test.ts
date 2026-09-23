import { describe, expect, it } from "vitest";
import { documentPdfStem, sanitizeFilenamePart, uniqueFilename } from "./documentFilename.js";

describe("documentPdfStem", () => {
  it("builds the Arabic naming convention for a sale invoice", () => {
    expect(
      documentPdfStem({
        docType: "sale",
        partyName: "شركة الشام",
        number: "INV-2026-0001",
        date: "2026-09-22",
      }),
    ).toBe("فاتورة_خروج_شركة_الشام_INV-2026-0001_2026-09-22");
  });

  it("strips NTFS-illegal characters from the party name", () => {
    const stem = documentPdfStem({
      docType: "sale",
      partyName: 'شركة/الشام:*?"<>|',
      number: "INV-1",
      date: "2026-09-22",
    });
    expect(stem).not.toMatch(/[<>:"/\\|?*]/);
    expect(stem).toContain("فاتورة_خروج");
  });
});

describe("sanitizeFilenamePart + uniqueFilename", () => {
  it("keeps Arabic letters", () => {
    expect(sanitizeFilenamePart("شركة الأمل")).toBe("شركة_الأمل");
  });

  it("suffixes duplicates instead of overwriting", () => {
    const existing = new Set(["فاتورة_خروج_شركة_الشام_INV-1_2026-09-22.pdf".toLowerCase()]);
    expect(uniqueFilename("فاتورة_خروج_شركة_الشام_INV-1_2026-09-22", existing)).toBe(
      "فاتورة_خروج_شركة_الشام_INV-1_2026-09-22_2",
    );
  });
});
