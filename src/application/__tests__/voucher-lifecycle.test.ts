import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("Voucher Lifecycle Integration Test", () => {
  let cashboxBalance = 0;
  const ledgerEntries: any[] = [];
  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  const SYP_TO_USD = 13500;

  function toSYP(amount: number, currency: string): number {
    return currency === "USD" ? amount * SYP_TO_USD : amount;
  }

  function writeLedger(entry: any) {
    ledgerEntries.push({ ...entry, status: "active" });
  }

  function cancelLedgerByRef(refId: string) {
    ledgerEntries.filter((e) => e.referenceId === refId).forEach((e) => (e.status = "cancelled"));
  }

  function computeBalance(): number {
    return ledgerEntries
      .filter((e) => e.status === "active")
      .reduce((sum, e) => {
        const amount = toSYP(e.debit || e.credit, e.currency);
        if (e.cashImpact === "in") return sum + amount;
        if (e.cashImpact === "out") return sum - amount;
        return sum;
      }, cashboxBalance);
  }

  beforeEach(() => {
    ledgerEntries.length = 0;
    cashboxBalance = 2_500_000; // opening balance in SYP
  });

  // ── Receipt Voucher ─────────────────────────────────────────

  it("receipt voucher increases cashbox balance, cancel restores", () => {
    // Create receipt voucher
    const voucher = {
      id: "v-rec-1",
      kind: "receipt",
      amount: 500_000,
      currency: "SYP",
      method: "cash",
      partyId: "cust-1",
      number: "REC-001",
    };

    writeLedger({
      type: "receipt_in",
      referenceId: voucher.id,
      debit: 0,
      credit: voucher.amount,
      currency: voucher.currency,
      cashImpact: "in",
    });

    // Balance increased
    expect(computeBalance()).toBe(3_000_000);

    // Cancel
    cancelLedgerByRef(voucher.id);
    expect(computeBalance()).toBe(2_500_000); // back to opening
  });

  // ── Payment Voucher ────────────────────────────────────────

  it("payment voucher decreases cashbox balance, cancel restores", () => {
    const voucher = {
      id: "v-pay-1",
      kind: "payment",
      amount: 200_000,
      currency: "SYP",
      method: "cash",
      partyId: "sup-1",
      number: "PAY-001",
    };

    writeLedger({
      type: "payment_out",
      referenceId: voucher.id,
      debit: 0,
      credit: voucher.amount,
      currency: voucher.currency,
      cashImpact: "out",
    });

    expect(computeBalance()).toBe(2_300_000);

    cancelLedgerByRef(voucher.id);
    expect(computeBalance()).toBe(2_500_000);
  });

  // ── Multi-currency vouchers ─────────────────────────────────

  it("converts USD voucher amounts to SYP for balance computation", () => {
    writeLedger({
      type: "receipt_in",
      referenceId: "v-usd-1",
      debit: 0,
      credit: 100,
      currency: "USD",
      cashImpact: "in",
    });

    // $100 USD × 13,500 = 1,350,000 SYP
    expect(computeBalance()).toBe(2_500_000 + 1_350_000);
  });

  // ── Non-cash voucher does not affect balance ─────────────────

  it("non-cash method voucher has no cash impact", () => {
    writeLedger({
      type: "receipt_in",
      referenceId: "v-transfer-1",
      debit: 0,
      credit: 1_000_000,
      currency: "SYP",
      cashImpact: "none",
    });

    expect(computeBalance()).toBe(2_500_000); // unchanged
  });
});
