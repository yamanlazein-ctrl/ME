/**
 * Customers/Suppliers review — source contracts for list freshness and honest states.
 *  - The list memo keys on the parties store SNAPSHOT: the cache refreshes by replacing objects inside
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
  it("filtered list depends on the store snapshot (changes on every store change)", () => {
    // The snapshot's identity changes on every change (useParties.snapshot.test.ts proves it); the
    // memo reads the rows through it, so the dependency is real — no version number, no disable.
    expect(table).toMatch(/const parties = useParties\(\);/);
    expect(table).toMatch(/kind === "supplier" \? parties\.suppliers : parties\.customers/);
    expect(table).toMatch(/\}, \[q, status, credit, kind, parties\]\);/);
    expect(table).not.toMatch(/list\.length\]\);/);
    expect(table).not.toMatch(/eslint-disable/);
  });
  it("export keeps cents (no Math.round on money; amounts are two-decimal)", () => {
    expect(table).not.toMatch(/Math\.round\(/);
    const model = readFileSync(join(__dirname, "partyExportModel.ts"), "utf8");
    expect(model).not.toMatch(/Math\.round\(/);
    expect(model).toMatch(/maximumFractionDigits: 2/);
    expect(model).toMatch(/minimumFractionDigits: 2/);
  });
  it("picker: a failed search is not 'no match'", () => {
    expect(combo).toContain("setSearchFailed(true)");
    expect(combo).toMatch(/noMatch = [^;]*!searchFailed/);
  });
});
