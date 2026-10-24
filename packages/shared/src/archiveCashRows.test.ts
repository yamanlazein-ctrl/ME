/**
 * Remediation Stage 1 — B-04: the cashbox snapshot must not report every outflow as 0.00.
 *
 * The snapshot route mapped a cash leg's amount with `debit ?? credit`. A cash-OUT leg is a CREDIT
 * entry — debit is 0 and credit holds the amount — and `??` only falls through on null/undefined,
 * never on 0. Every outflow therefore rendered as 0.00: a misstated cashbox in a financial
 * document, with no error and no failing test.
 */
import { describe, it, expect } from "vitest";
import { toArchiveCashRows, buildCashboxBody } from "./archiveDocuments.js";

describe("toArchiveCashRows", () => {
  it("reads a cash OUT (a credit entry, debit 0) as the credit amount, not 0", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-out",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "payment_out",
        currency: "SYP",
        debit: 0,
        credit: 500,
        cashImpact: "out",
        status: "active",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cashOut).toBe(500);
    expect(rows[0].cashIn).toBe(0);
  });

  it("reads a cash IN (a debit entry, credit 0) as the debit amount", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-in",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "receipt_in",
        currency: "SYP",
        debit: 250,
        credit: 0,
        cashImpact: "in",
        status: "active",
      },
    ]);
    expect(rows[0].cashIn).toBe(250);
    expect(rows[0].cashOut).toBe(0);
  });

  it("keeps the absolute value of a negative leg", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-neg",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "payment_out",
        currency: "SYP",
        debit: 0,
        credit: -750,
        cashImpact: "out",
        status: "active",
      },
    ]);
    expect(rows[0].cashOut).toBe(750);
  });

  it("ignores legs with no cash impact", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-none",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "invoice",
        currency: "SYP",
        debit: 900,
        credit: 0,
        cashImpact: "none",
        status: "active",
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("marks a cancelled leg as cancelled without changing its amount", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-cancelled",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "payment_out",
        currency: "SYP",
        debit: 0,
        credit: 100,
        cashImpact: "out",
        status: "cancelled",
      },
    ]);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].cashOut).toBe(100);
  });

  it("renders the outflow amount in the cashbox report, not 0.00", () => {
    const rows = toArchiveCashRows([
      {
        id: "leg-out",
        date: "2026-10-05",
        createdAt: "2026-10-05T09:00:00Z",
        type: "payment_out",
        currency: "SYP",
        debit: 0,
        credit: 500,
        cashImpact: "out",
        status: "active",
      },
    ]);
    const html = buildCashboxBody({ period: "2026-10", rows, openingByCurrency: {} });
    expect(html).toContain("500");
    // The row's cash-in cell is 0.00 (it is an outflow) and its cash-OUT cell must be 500.00.
    // With the old `debit ?? credit` mapping the outflow cell was 0.00 too, so the disbursement
    // silently vanished from the report.
    expect(html).toMatch(/<td class="arc-num">0\.00<\/td>\s*<td class="arc-num">500\.00<\/td>/);
  });
});
