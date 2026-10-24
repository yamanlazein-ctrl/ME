import { describe, it, expect } from "vitest";
import {
  ARCHIVE_CATEGORIES,
  ARCHIVE_CATEGORY_KEYS,
  appKey,
  categoryFolder,
  companyFolderName,
  documentFileName,
  monthFolder,
  sanitizeSegment,
  yearFolder,
} from "./archivePaths.js";

describe("companyFolderName", () => {
  it("names the root after the company", () => {
    expect(companyFolderName("شركة الأنسجة")).toBe("شركة الأنسجة - أرشيف النظام");
  });

  it("falls back to the product name when the company name is blank", () => {
    expect(companyFolderName("")).toBe("Motard ERP - أرشيف النظام");
    expect(companyFolderName(null)).toBe("Motard ERP - أرشيف النظام");
    expect(companyFolderName("   ")).toBe("Motard ERP - أرشيف النظام");
  });

  it("removes characters Windows and Drive refuse in folder names", () => {
    expect(companyFolderName('A/B:C*"D"')).toBe("A B C D - أرشيف النظام");
  });

  it("matches the shared naming engine the desktop shell mirrors", () => {
    // The SAME vectors as the Rust test in desktop-app/src-tauri/src/commands.rs
    // ("the_local_archive_root_uses_the_shared_naming_engine"). The local archive and the Drive
    // archive must have ONE layout, so both engines are pinned to the same table: if either side
    // drifts, one of the two tests fails.
    const cases: Array<[string, string]> = [
      ["موكتارد", "موكتارد - أرشيف النظام"],
      ["Motard Fabrics", "Motard Fabrics - أرشيف النظام"],
      ["", "Motard ERP - أرشيف النظام"],
      ["  ", "Motard ERP - أرشيف النظام"],
      ['a/b\\c:d*e?f"g<h>i|j', "a b c d e f g h i j - أرشيف النظام"],
      ["مؤسسة  النور", "مؤسسة النور - أرشيف النظام"],
    ];
    for (const [input, expected] of cases) {
      expect(companyFolderName(input)).toBe(expected);
    }
    expect(companyFolderName(null)).toBe("Motard ERP - أرشيف النظام");
    expect(companyFolderName(undefined)).toBe("Motard ERP - أرشيف النظام");
  });
});

describe("year and month folders", () => {
  it("derives the year from a business date", () => {
    expect(yearFolder("2026-10-14")).toBe("2026");
  });

  it("formats YYYY-MM with the Arabic month for every month", () => {
    const expected = [
      "يناير",
      "فبراير",
      "مارس",
      "أبريل",
      "مايو",
      "يونيو",
      "يوليو",
      "أغسطس",
      "سبتمبر",
      "أكتوبر",
      "نوفمبر",
      "ديسمبر",
    ];
    expected.forEach((name, i) => {
      const mm = String(i + 1).padStart(2, "0");
      expect(monthFolder(`2026-${mm}-01`)).toBe(`2026-${mm} — ${name}`);
    });
  });

  it("accepts a period key as well as a full date", () => {
    expect(monthFolder("2026-10")).toBe("2026-10 — أكتوبر");
  });

  it("sorts chronologically across the year boundary", () => {
    const names = ["2027-01-05", "2026-12-31", "2026-02-01"].map(monthFolder);
    expect([...names].sort()).toEqual(["2026-02 — فبراير", "2026-12 — ديسمبر", "2027-01 — يناير"]);
  });

  it("rejects impossible dates", () => {
    expect(() => monthFolder("2026-13-01")).toThrow(/INVALID_BUSINESS_DATE/);
    expect(() => yearFolder("not-a-date")).toThrow(/INVALID_BUSINESS_DATE/);
  });
});

describe("categories", () => {
  it("has exactly the seven fixed Arabic categories", () => {
    expect(ARCHIVE_CATEGORY_KEYS).toHaveLength(7);
    expect(Object.values(ARCHIVE_CATEGORIES)).toEqual([
      "فواتير الدخول",
      "فواتير الخروج",
      "المرتجعات",
      "إرساليات واستلامات الطباعة",
      "كشوف الحسابات",
      "الصندوق والتقارير",
      "نسخ النظام الاحتياطية",
    ]);
  });

  it("returns the folder label for each category", () => {
    expect(categoryFolder("sale_invoices")).toBe("فواتير الخروج");
    expect(categoryFolder("system_backups")).toBe("نسخ النظام الاحتياطية");
    expect(categoryFolder("print_jobs")).toBe("إرساليات واستلامات الطباعة");
  });

  it("refuses an unknown category", () => {
    expect(() => categoryFolder("payroll" as never)).toThrow(/UNKNOWN_ARCHIVE_CATEGORY/);
  });
});

describe("documentFileName", () => {
  const base = {
    businessDate: "2026-10-14",
    time: "09:30",
    docType: "sale",
    code: "INV-0042",
    partyName: "مؤسسة النور",
    ext: "pdf",
  };

  it("follows YYYY-MM-DD_HH-mm_<type>_<code>_<party>.pdf", () => {
    expect(documentFileName(base)).toBe("2026-10-14_09-30_sale_INV-0042_مؤسسة النور.pdf");
  });

  it("is deterministic: the same document always gets the same name", () => {
    expect(documentFileName(base)).toBe(documentFileName({ ...base }));
  });

  it("sorts newest-first when the names are reverse-sorted", () => {
    const names = [
      documentFileName({ ...base, businessDate: "2026-10-01", code: "A" }),
      documentFileName({ ...base, businessDate: "2026-10-09", code: "B" }),
      documentFileName({ ...base, businessDate: "2026-10-05", code: "C" }),
    ];
    expect([...names].sort().reverse()[0]).toContain("2026-10-09");
  });

  it("omits the party part when there is no party", () => {
    expect(documentFileName({ ...base, partyName: null })).toBe(
      "2026-10-14_09-30_sale_INV-0042.pdf",
    );
  });

  it("sanitizes hostile party and code values", () => {
    const name = documentFileName({ ...base, partyName: "a/b|c", code: "x:y" });
    expect(name).not.toMatch(/[/\\|:*?"<>]/);
  });

  it("caps the stem at 150 characters", () => {
    const name = documentFileName({ ...base, partyName: "ع".repeat(300) });
    expect(name.replace(/\.pdf$/, "").length).toBeLessThanOrEqual(150);
  });

  it("uses a placeholder time if the time is malformed rather than failing", () => {
    expect(documentFileName({ ...base, time: "9" })).toMatch(/^2026-10-14_00-00_/);
  });

  it("rejects a malformed business date", () => {
    expect(() => documentFileName({ ...base, businessDate: "14/10/2026" })).toThrow(
      /INVALID_BUSINESS_DATE/,
    );
  });

  it("normalizes the extension dot", () => {
    expect(documentFileName({ ...base, ext: ".pdf" })).toMatch(/\.pdf$/);
  });
});

describe("appKey", () => {
  it("is stable for the same document and does not include a content hash", () => {
    const k = appKey({ tenantId: "t1", docType: "sale", documentId: "inv-1" });
    expect(k).toBe("t1|sale|inv-1");
    expect(appKey({ tenantId: "t1", docType: "sale", documentId: "inv-1" })).toBe(k);
  });

  it("separates tenants, types and documents", () => {
    const base = appKey({ tenantId: "t1", docType: "sale", documentId: "inv-1" });
    expect(appKey({ tenantId: "t2", docType: "sale", documentId: "inv-1" })).not.toBe(base);
    expect(appKey({ tenantId: "t1", docType: "entry", documentId: "inv-1" })).not.toBe(base);
    expect(appKey({ tenantId: "t1", docType: "sale", documentId: "inv-2" })).not.toBe(base);
  });

  it("refuses an empty part", () => {
    expect(() => appKey({ tenantId: "t1", docType: "", documentId: "x" })).toThrow(
      /APP_KEY_PART_EMPTY/,
    );
  });
});

describe("sanitizeSegment", () => {
  it("keeps Arabic and digits", () => {
    expect(sanitizeSegment("شركة 2026")).toBe("شركة 2026");
  });
  it("never returns an empty segment", () => {
    expect(sanitizeSegment("///")).toBe("بدون-اسم");
  });
});
