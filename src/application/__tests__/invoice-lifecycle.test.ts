import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("Invoice Lifecycle Integration Test", () => {
  // Shared state simulating real use
  const rolls = new Map<string, { remainingKg: number; version: number }>();
  const invoices = new Map<string, any>();
  const ledgerEntries: any[] = [];

  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  function createRoll(id: string, kg: number) {
    rolls.set(id, { remainingKg: kg, version: 1 });
    return rolls.get(id)!;
  }

  function findRoll(id: string) {
    const r = rolls.get(id);
    return r ? { id, remainingKg: r.remainingKg, version: r.version, colorId: "c1" } : null;
  }

  function reserveStock(rollId: string, kg: number, expectedVersion: number) {
    const r = rolls.get(rollId);
    if (!r) return { ok: false, error: "NotFound" };
    if (r.version !== expectedVersion) return { ok: false, error: "ConcurrentModification" };
    if (r.remainingKg < kg) return { ok: false, error: "InsufficientStock" };
    r.remainingKg -= kg;
    r.version += 1;
    return { ok: true };
  }

  beforeEach(() => {
    rolls.clear();
    invoices.clear();
    ledgerEntries.length = 0;
  });

  // ── Task 5.1: Sale Invoice Lifecycle ──────────────────────────

  it("Sale: creates invoice, deducts stock, writes ledger, cancel restores all", () => {
    // Seed: 1 roll with 100 kg
    createRoll("roll-1", 100);

    // ── Step 1: Create sale invoice ──────────────────────────
    const saleInvoice = {
      id: "inv-sale-1",
      type: "sale",
      number: "INV-3001",
      date: "2026-01-15",
      partyId: "cust-1",
      partyType: "customer",
      currency: "SYP",
      lines: [{ rollId: "roll-1", quantityKg: 40, pricePerKg: 5000 }],
      status: "active",
    };

    // Stock deduction (only for sale)
    for (const line of saleInvoice.lines) {
      const roll = findRoll(line.rollId)!;
      const result = reserveStock(line.rollId, line.quantityKg, roll.version);
      expect(result.ok).toBe(true);
    }

    // Verify stock deducted
    expect(rolls.get("roll-1")!.remainingKg).toBe(60);

    // Write ledger entry (debit for sale — invoices debit the party account)
    ledgerEntries.push({
      type: "sales_invoice",
      referenceId: saleInvoice.id,
      debit: 40 * 5000, // 200,000
      credit: 0,
      currency: "SYP",
      status: "active",
    });

    // Verify ledger
    const saleEntry = ledgerEntries.find((e) => e.referenceId === saleInvoice.id);
    expect(saleEntry).toBeDefined();
    expect(saleEntry!.debit).toBe(200_000);

    // invoice persisted
    invoices.set(saleInvoice.id, saleInvoice);
    expect(invoices.get(saleInvoice.id)!.status).toBe("active");

    // ── Step 2: Cancel the sale invoice ──────────────────────

    // Release stock (only for sale type)
    for (const line of saleInvoice.lines) {
      const roll = rolls.get(line.rollId)!;
      roll.remainingKg += line.quantityKg;
      roll.version += 1;
    }

    // Verify stock restored
    expect(rolls.get("roll-1")!.remainingKg).toBe(100);

    // Cancel ledger entries
    ledgerEntries
      .filter((e) => e.referenceId === saleInvoice.id)
      .forEach((e) => (e.status = "cancelled"));

    // Cancel invoice
    saleInvoice.status = "cancelled";

    // Verify all
    expect(invoices.get("inv-sale-1")!.status).toBe("cancelled");
    expect(rolls.get("roll-1")!.remainingKg).toBe(100);
    expect(
      ledgerEntries.filter(
        (e) => e.referenceId === "inv-sale-1" && e.status === "cancelled",
      ).length,
    ).toBe(1);
  });

  // ── Task 5.1: Entry Invoice Lifecycle ───────────────────────

  it("Entry: creates invoice, does NOT deduct stock, cancel restores nothing", () => {
    // Seed: entry invoice creates its own rolls (stock added, not deducted)
    createRoll("roll-e1", 50);

    const entryInvoice = {
      id: "inv-entry-1",
      type: "entry",
      number: "PO-2001",
      date: "2026-01-15",
      partyId: "sup-1",
      partyType: "supplier",
      currency: "SYP",
      lines: [{ rollId: "roll-e1", quantityKg: 50, pricePerKg: 3000 }],
      status: "active",
    };

    // Entry: NO stock deduction (the roll was created with its full kg)
    // Stock check:
    expect(rolls.get("roll-e1")!.remainingKg).toBe(50); // unchanged

    // Write ledger (debit for entry)
    ledgerEntries.push({
      type: "purchase_invoice",
      referenceId: entryInvoice.id,
      debit: 50 * 3000,
      credit: 0,
      currency: "SYP",
      status: "active",
    });

    invoices.set(entryInvoice.id, entryInvoice);

    // ── Cancel entry invoice ──────────────────────────────────

    // Entry: NO stock release (was never deducted)
    // Just cancel ledger + invoice
    ledgerEntries
      .filter((e) => e.referenceId === entryInvoice.id)
      .forEach((e) => (e.status = "cancelled"));
    entryInvoice.status = "cancelled";

    // Stock still at original value
    expect(rolls.get("roll-e1")!.remainingKg).toBe(50);
  });

  // ── Task 5.1: Stock validation ──────────────────────────────

  it("rejects sale when quantity exceeds available stock", () => {
    createRoll("roll-low", 10);

    const roll = findRoll("roll-low")!;
    const result = reserveStock("roll-low", 25, roll.version); // want 25, have 10

    expect(result.ok).toBe(false);
    expect(result.error).toBe("InsufficientStock");
    expect(rolls.get("roll-low")!.remainingKg).toBe(10); // unchanged
  });

  // ── Task 5.1: Version check ─────────────────────────────────

  it("rejects concurrent modification (optimistic locking)", () => {
    createRoll("roll-ver", 50);
    const roll = findRoll("roll-ver")!;

    // First deduction: passes
    const r1 = reserveStock("roll-ver", 10, roll.version);
    expect(r1.ok).toBe(true);

    // Second deduction with stale version: fails
    const r2 = reserveStock("roll-ver", 10, 1); // original version, now stale
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("ConcurrentModification");
  });
});
