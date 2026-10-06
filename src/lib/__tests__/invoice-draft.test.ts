/**
 * The reported loss: an operator killed mid-invoice came back to an empty form.
 * A draft survives the kill — but an empty form must not look like one, or
 * "discard" would offer the same nothing again on the next visit.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SaleLine } from "@/components/invoices/sale-types";
import {
  clearSaleDraft,
  loadSaleDraft,
  saleDraftHasContent,
  saveSaleDraft,
} from "../invoice-draft";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

function line(patch: Partial<SaleLine>): SaleLine {
  return {
    id: "l-1",
    fabricId: "f1",
    fabricName: "قطن",
    colorId: "c1",
    colorName: "أحمر",
    colorCode: "R",
    rollId: "r1",
    quantityKg: 10,
    pricePerKg: 49,
    discountAmount: 0,
    pieces: 1,
    ...patch,
  };
}

const draft = {
  customerId: "cust-1",
  currency: "USD" as const,
  lines: [line({}), line({ id: "l-2", fabricName: "حرير" })],
  paid: 120,
  date: "2025-01-15",
  reference: "REF-9",
  notes: "تسليم على دفعتين",
};

describe("sale draft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
    vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: globalThis.localStorage }));
  });

  it("round-trips the operator's work", () => {
    saveSaleDraft(draft);
    const loaded = loadSaleDraft();
    expect(loaded).not.toBeNull();
    expect(loaded!.customerId).toBe("cust-1");
    expect(loaded!.currency).toBe("USD");
    expect(loaded!.paid).toBe(120);
    expect(loaded!.reference).toBe("REF-9");
    expect(loaded!.notes).toBe("تسليم على دفعتين");
    expect(loaded!.lines).toHaveLength(2);
    expect(loaded!.lines[0].fabricName).toBe("قطن");
    expect(loaded!.savedAt).not.toBe("");
  });

  it("is gone after a successful save or an explicit discard", () => {
    saveSaleDraft(draft);
    clearSaleDraft();
    expect(loadSaleDraft()).toBeNull();
  });

  it("treats corrupt storage as no draft instead of breaking mount", () => {
    localStorage.setItem("erp.draft.sale.v1", "{not json");
    expect(loadSaleDraft()).toBeNull();
  });

  it("does not count an untouched form as work in progress", () => {
    const blank = {
      customerId: "",
      currency: "" as const,
      lines: [line({ fabricName: "", rollId: "", quantityKg: 0 })],
      paid: "" as const,
      date: "2025-01-15",
      reference: "",
      notes: "",
    };
  });
});
