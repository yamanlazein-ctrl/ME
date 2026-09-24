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
  it("follows nextCursor (keyset) and passes it back — page numbers are not used for seeking", async () => {
    const calls: Array<{ page: number; cursor?: string }> = [];
    const out = await fetchAllPaged(
      async (page, limit, cursor) => {
        calls.push({ page, cursor });
        const start = cursor ? Number(cursor) : 0;
        const data = rows.slice(start, start + limit);
        const end = start + data.length;
        return { data, meta: { hasNext: end < rows.length, nextCursor: end < rows.length ? String(end) : null } };
      },
      { pageSize: 10 },
    );
    expect(out).toEqual(rows);
    expect(calls.map((c) => c.cursor)).toEqual([undefined, "10", "20"]);
  });

  it("a cursor walk ends when the cursor stops, even if a stale hasNext says more", async () => {
    let n = 0;
    const out = await fetchAllPaged(
      async (_page, limit, cursor) => {
        n++;
        if (!cursor) return { data: rows.slice(0, limit), hasNext: true, nextCursor: "c1" };
        return { data: rows.slice(limit, limit + 3), hasNext: true, nextCursor: undefined };
      },
      { pageSize: 10 },
    );
    expect(out).toEqual(rows.slice(0, 13));
    expect(n).toBe(2);
  });

  it("repository-style top-level nextCursor is honoured", async () => {
    const out = await fetchAllPaged(
      async (_page, limit, cursor) => {
        const start = cursor ? Number(cursor) : 0;
        const data = rows.slice(start, start + limit);
        const end = start + data.length;
        return { data, total: rows.length, hasNext: end < rows.length, nextCursor: end < rows.length ? String(end) : undefined };
      },
      { pageSize: 7 },
    );
    expect(out).toEqual(rows);
  });
});
