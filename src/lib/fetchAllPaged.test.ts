import { describe, expect, it, vi } from "vitest";
import { fetchAllPaged } from "./fetchAllPaged";

const rows = Array.from({ length: 25 }, (_, i) => i);
const pageOf = (page: number, limit: number) => rows.slice(page * limit, page * limit + limit);

describe("fetchAllPaged", () => {
  it("follows repository-style { data, hasNext } (top-level hasNext)", async () => {
    const seen: number[] = [];
    const out = await fetchAllPaged(
      async (page, limit) => {
        seen.push(page);
        const data = pageOf(page, limit);
        return { data, total: rows.length, hasNext: (page + 1) * limit < rows.length };
      },
      { pageSize: 10 },
    );
    expect(out).toEqual(rows);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("follows API-envelope { data, meta: { hasNext } }", async () => {
    const out = await fetchAllPaged(
      async (page, limit) => ({
        data: pageOf(page, limit),
        meta: { hasNext: (page + 1) * limit < rows.length },
      }),
      { pageSize: 10 },
    );
    expect(out).toEqual(rows);
  });

  it("bare arrays stop on a short page", async () => {
    const out = await fetchAllPaged(async (page, limit) => pageOf(page, limit), { pageSize: 10 });
    expect(out).toEqual(rows);
  });

  it("refuses to return a truncated list at maxPages (totals would be wrong)", async () => {
    await expect(
      fetchAllPaged(
        async (page, limit) => ({ data: pageOf(page, limit), hasNext: true }),
        { pageSize: 10, maxPages: 2, label: "t" },
      ),
    ).rejects.toThrow(/refusing to return a truncated list/);
  });
});
