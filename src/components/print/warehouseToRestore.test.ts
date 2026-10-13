/**
 * Lint finding react-hooks/exhaustive-deps (invoices.sale.new.tsx) — the edit prefill restored the
 * invoice's warehouse only if the warehouse list was ALREADY loaded; otherwise the invoice silently
 * moved to the default warehouse on re-save. The decision now waits for the list.
 */
import { describe, it, expect } from "vitest";
import { warehouseToRestore } from "./noteParser";

const notes = "المرجع: R-7 • المستودع: w2 • ملاحظة";

describe("warehouseToRestore", () => {
  it("waits (null) while the warehouse list is empty or lacks the stored id", () => {
    expect(warehouseToRestore(notes, [])).toBeNull();
    expect(warehouseToRestore(notes, [{ id: "w1" }])).toBeNull();
  });
  it("restores the stored warehouse once the list contains it", () => {
    expect(warehouseToRestore(notes, [{ id: "w1" }, { id: "w2" }])).toBe("w2");
  });
  it("nothing to restore when the invoice stored no warehouse", () => {
    expect(warehouseToRestore("المرجع: R-7", [{ id: "w1" }])).toBeNull();
    expect(warehouseToRestore(null, [{ id: "w1" }])).toBeNull();
  });
});
