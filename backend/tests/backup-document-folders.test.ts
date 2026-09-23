import { describe, it, expect } from "vitest";
import { fetchAllPages, safeFileStem } from "../src/presentation/routes/backup.route.js";

/**
 * Unit coverage for the structured-backup helpers added 2026-09-22
 * (folders "فواتير دخول"/"فواتير خروج"/"سندات القبض"/"سندات الصرف"/
 * "كشوفات الحسابات"). The DB-backed part of the route (fetching real
 * invoices/vouchers/parties/statements) needs a live Postgres instance not
 * available in this environment — see `buildDocumentFolders` in
 * backup.route.ts, NOT covered here.
 */
describe("safeFileStem", () => {
  it("strips NTFS-illegal characters from a document number", () => {
    expect(safeFileStem('INV/2026:0001"?*')).toBe("INV_2026_0001___");
  });

  it("falls back to a placeholder for an empty stem", () => {
    expect(safeFileStem("   ")).toBe("بدون-رقم");
  });

  it("keeps a normal Arabic party name untouched", () => {
    expect(safeFileStem("شركة الأمل للأقمشة")).toBe("شركة الأمل للأقمشة");
  });
});

function page<T>(data: T[], hasNext: boolean, pageNum: number) {
  return { data, meta: { total: 5, page: pageNum, limit: 2, hasNext, totalPages: 3 } };
}

describe("fetchAllPages", () => {
  it("drains every page until hasNext is false", async () => {
    const pages = [page([1, 2], true, 0), page([3, 4], true, 1), page([5], false, 2)];
    let calls = 0;
    const all = await fetchAllPages(async (p) => {
      calls += 1;
      return pages[p]!;
    });
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBe(3);
  });

  it("returns an empty array when the first page is already empty", async () => {
    const all = await fetchAllPages(async () => page<number>([], false, 0));
    expect(all).toEqual([]);
  });
});
