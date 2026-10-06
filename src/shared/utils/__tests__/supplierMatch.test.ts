/**
 * Bug #1 — an existing supplier must be selectable, and never duplicated.
 *
 * These cases drive `findSupplierByExactName`, the exact function the
 * purchase-invoice combobox calls (`SupplierInlineCombobox` → `exactExisting`,
 * `openAdd`, `commitAdd`). There is no mock and no copy of the rule in this
 * file: if the component's duplicate guard regresses, or the rule is inlined
 * and diverges, these fail.
 */
import { describe, it, expect } from "vitest";
import { findSupplierByExactName } from "../supplierMatch";

const EXISTING = [
  { id: "s-1", name: "مؤسسة النور", phone: "0933-111" },
  { id: "s-2", name: "أحمد محمد", phone: null },
  { id: "s-3", name: "  مصنعThreads  ", phone: null },
];

describe("existing supplier selection (bug #1)", () => {
  it("resolves the existing supplier so it can be selected instead of recreated", () => {
    const hit = findSupplierByExactName(EXISTING, "مؤسسة النور");
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("s-1");
  });

  it("matches case-insensitively", () => {
    expect(findSupplierByExactName([{ id: "x", name: "ACME Trading" }], "acme trading")!.id).toBe(
      "x",
    );
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(findSupplierByExactName(EXISTING, "  مؤسسة النور  ")!.id).toBe("s-1");
    // …and a stored name that itself has stray spaces still matches.
    expect(findSupplierByExactName(EXISTING, "مصنعThreads")!.id).toBe("s-3");
  });

  it("a genuinely new name resolves to nothing, so creation may proceed", () => {
    expect(findSupplierByExactName(EXISTING, "مورد جديد تماماً")).toBeNull();
  });

  it("does NOT treat a partial name as the same supplier", () => {
    // "أحمد" and "أحمد محمد" are different accounts. Resolving one for the
    // other would post a purchase invoice to the wrong supplier.
    expect(findSupplierByExactName(EXISTING, "أحمد")).toBeNull();
    expect(findSupplierByExactName(EXISTING, "مؤسسة")).toBeNull();
  });

  it("a blank query matches nothing (an empty box is not a supplier named '')", () => {
    expect(findSupplierByExactName(EXISTING, "")).toBeNull();
    expect(findSupplierByExactName(EXISTING, "   ")).toBeNull();
    expect(findSupplierByExactName(EXISTING, null)).toBeNull();
    expect(findSupplierByExactName(EXISTING, undefined)).toBeNull();
  });

  it("is safe when the supplier list has not loaded yet", () => {
    expect(findSupplierByExactName([], "مؤسسة النور")).toBeNull();
  });
});
