import { describe, expect, it } from "vitest";
import {
  evaluateDrop,
  type IntegrityCounts,
} from "../src/infrastructure/integrity/dataIntegrityManifest.js";

const base = (over: Partial<IntegrityCounts> = {}): IntegrityCounts => ({
  tenants: 1,
  users: 3,
  parties: 100,
  invoices: 1000,
  invoiceLines: 5000,
  rolls: 200,
  ledgerEntries: 8000,
  vouchers: 400,
  returns: 10,
  syncOutboxPending: 0,
  ...over,
});

describe("evaluateDrop (REPAIR-023)", () => {
  it("no drop", () => {
    expect(evaluateDrop(base(), base()).severe).toBe(false);
  });

  it("small drop below absolute threshold", () => {
    expect(evaluateDrop(base({ invoices: 100 }), base({ invoices: 85 })).severe).toBe(false);
  });

  it("10% drop on large count is severe", () => {
    const r = evaluateDrop(base({ invoices: 1000 }), base({ invoices: 850 }));
    expect(r.severe).toBe(true);
    expect(r.drops.some((d) => d.key === "invoices")).toBe(true);
  });

  it("absolute drop of 21 on small set is severe", () => {
    const r = evaluateDrop(base({ parties: 50 }), base({ parties: 29 }));
    expect(r.severe).toBe(true);
  });

  it("first run with zero prev is never severe", () => {
    expect(evaluateDrop(base({ invoices: 0 }), base({ invoices: 0 })).severe).toBe(false);
  });
});
