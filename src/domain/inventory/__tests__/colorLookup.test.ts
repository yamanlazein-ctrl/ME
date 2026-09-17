import { describe, expect, it } from "vitest";
import {
  colorOnFabric,
  filterColorsByQuery,
  resolveColorPick,
  type ColorLookupRow,
} from "../colorLookup";

const cotton = {
  id: "c-olive-cotton",
  fabricId: "fab-cotton",
  name: "زيتي",
  code: "101",
  hex: "#3b4a2f",
};
const jeansOlive = {
  id: "c-olive-jeans",
  fabricId: "fab-jeans",
  name: "زيتي",
  code: "202",
};
const cottonRed = {
  id: "c-red-cotton",
  fabricId: "fab-cotton",
  name: "أحمر",
  code: "301",
};
const catalog: ColorLookupRow[] = [cotton, jeansOlive, cottonRed];

describe("filterColorsByQuery", () => {
  it("does not dump the catalogue when the query is empty", () => {
    expect(filterColorsByQuery(catalog, "")).toEqual([]);
    expect(filterColorsByQuery(catalog, "   ")).toEqual([]);
  });

  it("returns only names/codes related to the typed term", () => {
    const hits = filterColorsByQuery(catalog, "زيتي");
    expect(hits.map((c) => c.id).sort()).toEqual(["c-olive-cotton", "c-olive-jeans"]);
    expect(filterColorsByQuery(catalog, "أحمر").map((c) => c.id)).toEqual(["c-red-cotton"]);
  });
});

describe("colorOnFabric + resolveColorPick", () => {
  it("does not treat another fabric's color as belonging to this fabric", () => {
    expect(colorOnFabric(catalog, "fab-jeans", { name: "أحمر" })).toBeUndefined();
    expect(colorOnFabric(catalog, "fab-jeans", { name: "زيتي" })?.id).toBe("c-olive-jeans");
  });

  it("reuses the local row when picking a same-named color from another fabric", () => {
    const r = resolveColorPick(cotton as ColorLookupRow, "fab-jeans", catalog);
    expect(r.existingColorId).toBe("c-olive-jeans");
    expect(r.crossFabric).toBe(false);
  });

  it("does not bind cotton's id when jeans has no زيتي yet — save will create", () => {
    const jeansOnlyRed: ColorLookupRow[] = [cotton, cottonRed];
    const r = resolveColorPick(cotton as ColorLookupRow, "fab-jeans", jeansOnlyRed);
    expect(r.existingColorId).toBeUndefined();
    expect(r.crossFabric).toBe(true);
    expect(r.colorName).toBe("زيتي");
    expect(r.hex).toBe("#3b4a2f");
  });

  it("binds the id when the pick is already on the target fabric", () => {
    const r = resolveColorPick(jeansOlive as ColorLookupRow, "fab-jeans", catalog);
    expect(r.existingColorId).toBe("c-olive-jeans");
    expect(r.crossFabric).toBe(false);
  });
});
