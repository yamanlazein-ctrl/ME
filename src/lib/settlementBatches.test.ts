import { describe, it, expect } from "vitest";
import { groupSettlementBatches, settlementBatchNumber } from "./settlementBatches";

const v = (o: Partial<Parameters<typeof groupSettlementBatches>[0][number]> & { id: string }) => ({
  partyId: "p1",
  partyKind: "customer" as const,
  date: "2026-09-20",
  amount: 100,
  currency: "SYP",
  status: "active",
  notesInternal: null,
  notesPrint: null,
  ...o,
});

describe("settlement batches", () => {
  it("finds the SET number in internal or print notes", () => {
    expect(settlementBatchNumber({ notesInternal: "دفعة SET-2026-0007 — 2 فاتورة" })).toBe(
      "SET-2026-0007",
    );
    expect(settlementBatchNumber({ notesPrint: "جزء من الدفعة set-2026-0008" })).toBe(
      "SET-2026-0008",
    );
    expect(settlementBatchNumber({ notesInternal: "سند عادي" })).toBeNull();
  });

  it("groups vouchers of one batch into a single row and ignores plain vouchers", () => {
    const rows = groupSettlementBatches([
      v({ id: "a", amount: 60, notesInternal: "دفعة SET-2026-0001 — 2 فاتورة" }),
      v({ id: "b", amount: 40, notesPrint: "جزء من الدفعة SET-2026-0001" }),
      v({ id: "c", amount: 5 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      batchNumber: "SET-2026-0001",
      total: 100,
      voucherCount: 2,
      status: "active",
    });
  });

  it("is cancelled only when every voucher in the batch is cancelled", () => {
    const all = groupSettlementBatches([
      v({ id: "a", status: "cancelled", notesInternal: "SET-2026-0002" }),
      v({ id: "b", status: "cancelled", notesInternal: "SET-2026-0002" }),
    ]);
    expect(all[0]).toMatchObject({ status: "cancelled", total: 0 });
    const mixed = groupSettlementBatches([
      v({ id: "a", status: "cancelled", notesInternal: "SET-2026-0003" }),
      v({ id: "b", amount: 30, notesInternal: "SET-2026-0003" }),
    ]);
    expect(mixed[0]).toMatchObject({ status: "active", total: 30 });
  });
});
