import { describe, it, expect } from "vitest";
import { addManualMovementUseCase } from "@/application/use-cases/cashbox/cashboxUseCases";
import { createVoucherUseCase } from "@/application/use-cases/vouchers/voucherUseCases";
import { InsufficientCashboxBalanceError } from "@/domain/errors/index";

/**
 * Business rule (field report 2026-09): negative cashbox balances ARE allowed.
 * The repository helper serializes concurrent cash-outs but no longer throws
 * InsufficientCashboxBalanceError. These tests keep the use-case error-mapping
 * contract for the rare case a repository still throws (legacy / defensive),
 * and prove cash payments succeed when the repo accepts the write.
 */
const ctx = { tenantId: "t1", userId: "u1" } as never;

describe("addManualMovementUseCase — negative cash allowed", () => {
  it("still surfaces InsufficientCashboxBalanceError if a repo throws it", async () => {
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

  it("accepts cash-out that would leave the cashbox negative", async () => {
    const repo = {
      addManualMovement: async (input: { direction: string; amount: number }) => ({
        id: "m1",
        tenantId: "t1",
        date: "2026-09-16",
        type: "capital",
        direction: input.direction,
        amount: input.amount,
        currency: "USD",
        createdAt: new Date().toISOString(),
      }),
    };
    const r = await addManualMovementUseCase(
      repo as never,
      { date: "2026-09-16", type: "capital", direction: "out", amount: 110, currency: "USD" } as never,
      ctx,
    );
    expect(r.ok).toBe(true);
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

describe("createVoucherUseCase — negative cash payment allowed", () => {
  it("succeeds when the repository accepts a cash payment over available balance", async () => {
    const repo = {
      create: async (input: { amount: number }) => ({
        id: "v1",
        tenantId: "t1",
        kind: "payment",
        number: "PAY-1",
        date: "2026-09-16",
        partyId: "p1",
        partyKind: "supplier",
        amount: input.amount,
        discount: 0,
        currency: "USD",
        method: "cash",
        status: "active",
        version: 1,
        createdAt: new Date().toISOString(),
      }),
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
        amount: 110,
        currency: "USD",
      } as never,
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it("still maps InsufficientCashboxBalanceError if a repo throws it", async () => {
    const repo = {
      create: async () => {
        throw new InsufficientCashboxBalanceError("USD", -200, 110);
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
        amount: 110,
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
