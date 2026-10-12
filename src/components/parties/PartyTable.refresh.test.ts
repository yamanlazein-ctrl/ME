/**
 * Customers/Suppliers review — source contracts for list freshness and honest states.
 *  - The list memo keys on the parties cache VERSION: the cache refreshes by replacing objects inside
 *    the same array, so keying on `list.length` kept showing a renamed party / old balance.
 *  - CSV money is exported with round2dp (Math.round dropped USD cents: 12.50 → 13).
 *  - The party picker reports a failed search instead of «الاسم غير موجود» (which invited a duplicate).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const table = readFileSync(join(__dirname, "PartyTable.tsx"), "utf8");
const combo = readFileSync(join(__dirname, "../vouchers/PartyCombobox.tsx"), "utf8");

describe("party list freshness", () => {
  it("filtered list depends on the cache version", () => {
    expect(table).toMatch(/const partiesVersion = useParties\(\);/);
    expect(table).toMatch(/\}, \[q, status, credit, list, partiesVersion\]\);/);
    expect(table).not.toMatch(/list\.length\]\);/);
  });
  it("CSV keeps cents", () => {
    expect(table).not.toMatch(/String\(Math\.round\(s\./);
    expect(table).toMatch(/String\(round2dp\(s\.remaining\)\)/);
  });
  it("picker: a failed search is not 'no match'", () => {
    expect(combo).toContain("setSearchFailed(true)");
    expect(combo).toMatch(/noMatch = [^;]*!searchFailed/);
  });
});
