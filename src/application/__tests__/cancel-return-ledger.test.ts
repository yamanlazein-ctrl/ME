import { describe, it, expect, vi } from "vitest";
import { TenantContext, UUID } from "@/domain/types";
import { CancelReturnUseCase } from "@/application/use-cases/returns/CancelReturnUseCase";
import { CancelVoucherUseCase } from "@/application/use-cases/vouchers/CancelVoucherUseCase";
import { ApiLedgerRepository } from "@/infrastructure/repositories/api/ApiLedgerRepository";

/**
 * VERIFIED_REMEDIATION_PLAN ERP-007 — the server cancel owns the ledger/stock reversal. The use cases
 * used to call `ledger.cancelByReference` afterwards, which the real API ledger adapter refuses, so
 * every successful cancel surfaced as a failure (no cache refresh, voucher amend aborted).
 */
const ctx: TenantContext = {
  tenantId: "t1" as UUID,
  userId: "u1" as UUID,
  userRole: "admin",
  userName: "tester",
};

describe("cancel use cases with the real API ledger adapter", () => {
  it("the real adapter refuses client-side ledger cancellation (the reason for ERP-007)", async () => {
    await expect(
      new ApiLedgerRepository({} as never).cancelByReference("x" as UUID, ctx),
    ).rejects.toThrow();
  });

  it("cancelling a return resolves after the server cancel", async () => {
    const returns = {
      findById: vi.fn().mockResolvedValue({ id: "ret-1", version: 3, status: "active" }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      new CancelReturnUseCase(returns as never).execute("ret-1" as UUID, ctx),
    ).resolves.toBeUndefined();
    expect(returns.cancel).toHaveBeenCalledWith("ret-1", ctx, 3);
  });

  it("cancelling a voucher resolves Ok after the server cancel", async () => {
    const active = { id: "v-1", number: "R-1", version: 2, canCancel: () => true };
    const vouchers = {
      findById: vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce({ ...active, status: "cancelled" }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const r = await new CancelVoucherUseCase(vouchers as never).execute("v-1" as UUID, ctx);
    expect(r.ok).toBe(true);
    expect(vouchers.cancel).toHaveBeenCalledWith("v-1", ctx, 2);
  });
});
