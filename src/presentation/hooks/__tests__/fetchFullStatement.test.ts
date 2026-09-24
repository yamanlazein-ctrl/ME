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

  it("explicit cursor returns just that page", async () => {
    const r = await fetchFullStatement(server, { limit: 200, cursor: "200" });
    expect(r.entries).toHaveLength(200);
    expect(r.entries[0]!.id).toBe(200);
  });
});
