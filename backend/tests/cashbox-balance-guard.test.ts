import { describe, it, expect } from "vitest";
import { addManualMovementUseCase } from "@/application/use-cases/cashbox/cashboxUseCases";
import { createVoucherUseCase } from "@/application/use-cases/vouchers/voucherUseCases";
import { InsufficientCashboxBalanceError } from "@/domain/errors/index";

/**
 * Regression tests for F06 (Phase 1 audit) + the "hard block" overdraft
 * decision: a cash withdrawal or cash payment voucher that would take the
 * cashbox negative must be rejected, not silently allowed (SYP previously
 * reached -14,110 with no guard at all).
 *
 * These are unit tests against the use-case error-mapping contract — the
 * actual balance arithmetic lives in
 * `src/infrastructure/repositories/cashboxBalanceHelper.ts` and requires a
 * live Postgres instance (SUM over ledger_entries/manual_movements inside a
 * transaction with an advisory lock), which is not available in this
 * environment. That SQL-level behavior is NOT PROVEN here — only that a
 * thrown `InsufficientCashboxBalanceError` from the repository layer is
 * correctly surfaced as a rejected `Result`, never swallowed into a generic
 * "internal error" or (worse) treated as success.
 */
const ctx = { tenantId: "t1", userId: "u1" } as never;

describe("addManualMovementUseCase — F06 overdraft guard propagation", () => {
  it("surfaces InsufficientCashboxBalanceError as a rejected result with its code", async () => {
    const repo = {
      addManualMovement: async () => {
        throw new InsufficientCashboxBalanceError("SYP", 1000, 5000);
      },
    };
    const r = await addManualMovementUseCase(
      repo as never,
      { date: "2026-09-16", type: "capital", direction: "out", amount: 5000, currency: "SYP" } as never,
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect("code" in r ? r.code : undefined).toBe("INSUFFICIENT_CASHBOX_BALANCE");
      expect(r.error).toMatch(/غير كافٍ/);
    }
  });

  it("does not reject an inbound (direction: in) movement based on balance", async () => {
    const repo = {
      addManualMovement: async (input: { direction: string }) => ({
        id: "m1",
        tenantId: "t1",
        date: "2026-09-16",
        type: "capital",
        direction: input.direction,
        amount: 5000,
        currency: "SYP",
        createdAt: new Date().toISOString(),
      }),
    };
    const r = await addManualMovementUseCase(
      repo as never,
      { date: "2026-09-16", type: "capital", direction: "in", amount: 5000, currency: "SYP" } as never,
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});

describe("createVoucherUseCase — F06 overdraft guard propagation (cash payment vouchers)", () => {
  it("surfaces InsufficientCashboxBalanceError as a rejected result", async () => {
    const repo = {
      create: async () => {
        throw new InsufficientCashboxBalanceError("USD", 10, 100);
      },
    };
    const audit = { create: async () => undefined };
    const r = await createVoucherUseCase(
      repo as never,
      audit as never,
      {
        kind: "payment",
        method: "cash",
        date: "2026-09-16",
        partyId: "p1",
        partyKind: "supplier",
        amount: 100,
        currency: "USD",
      } as never,
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/غير كافٍ/);
    }
  });
});
