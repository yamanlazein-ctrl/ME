import { describe, it, expect } from "vitest";
import { DEFAULT_SUGGESTION_COUNT, recentSuggestions } from "../suggestions";

describe("recentSuggestions", () => {
  it("defaults to 5 newest-first records", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      createdAt: new Date(2026, 0, i + 1).toISOString(),
    }));
    const out = recentSuggestions(items);
    expect(DEFAULT_SUGGESTION_COUNT).toBe(5);
    expect(out.map((x) => x.id)).toEqual(["r7", "r6", "r5", "r4", "r3"]);
  });

  it("keeps original order for undated items, after dated ones, without mutating input", () => {
    const items = [
      { id: "a" },
      { id: "b", createdAt: "2026-02-01T00:00:00Z" },
      { id: "c" },
      { id: "d", createdAt: "not-a-date" },
    ];
    const snapshot = items.map((x) => x.id);
    expect(recentSuggestions(items, 10).map((x) => x.id)).toEqual(["b", "a", "c", "d"]);
    expect(items.map((x) => x.id)).toEqual(snapshot);
  });

  it("returns fewer than the limit when the list is short and [] when empty", () => {
    expect(recentSuggestions([{ createdAt: "2026-01-01" }])).toHaveLength(1);
    expect(recentSuggestions([])).toEqual([]);
  });
});
