import { describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/container", () => ({ container: {} }));
import { fetchFullStatement } from "../useStatement";

type Page = {
  entries: Array<{ id: number; runningBalance: number }>;
  finalBalance: number;
  page: { hasMore: boolean; nextCursor: string | null; limit: number };
};

// 450 rows, server page size 200 then 500 — each row +1 on the balance.
const all = Array.from({ length: 450 }, (_, i) => ({ id: i, runningBalance: i + 1 }));
function server(f: { cursor?: string; limit?: number }): Promise<Page> {
  const start = f.cursor ? Number(f.cursor) : 0;
  const limit = f.limit ?? 200;
  const slice = all.slice(start, start + limit);
  const more = start + limit < all.length;
  return Promise.resolve({
    entries: slice,
    finalBalance: 450,
    page: { hasMore: more, nextCursor: more ? String(start + limit) : null, limit },
  });
}

describe("fetchFullStatement", () => {
  it("returns every row across pages, in order, with header from page 1", async () => {
    const r = await fetchFullStatement(server, { limit: 200 });
    expect(r.entries).toHaveLength(450);
    expect(r.entries.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(r.entries.at(-1)!.runningBalance).toBe(r.finalBalance);
    expect(r.page.hasMore).toBe(false);
  });

  it("has no page cap: walks more than 1000 follow-up pages (track P, C-11)", async () => {
    // 1 + 1500 pages of one row each; the old loop stopped silently after 1000.
    const pages = 1501;
    const tiny = (f: { cursor?: string }): Promise<Page> => {
      const i = f.cursor ? Number(f.cursor) : 0;
      const more = i + 1 < pages;
      return Promise.resolve({
        entries: [{ id: i, runningBalance: i + 1 }],
        finalBalance: pages,
        page: { hasMore: more, nextCursor: more ? String(i + 1) : null, limit: 1 },
      });
    };
    const r = await fetchFullStatement(tiny, { limit: 1 });
    expect(r.entries).toHaveLength(pages);
    expect(r.entries.at(-1)!.runningBalance).toBe(pages);
  });

  it("fails loudly instead of truncating when the cursor does not advance", async () => {
    const stuck = (): Promise<Page> =>
      Promise.resolve({ entries: [{ id: 0, runningBalance: 1 }], finalBalance: 1, page: { hasMore: true, nextCursor: "same", limit: 1 } });
    await expect(fetchFullStatement(stuck, { limit: 1 })).rejects.toThrow(/did not advance/);
  });

  it("explicit cursor returns just that page", async () => {
    const r = await fetchFullStatement(server, { limit: 200, cursor: "200" });
    expect(r.entries).toHaveLength(200);
    expect(r.entries[0]!.id).toBe(200);
  });
});
