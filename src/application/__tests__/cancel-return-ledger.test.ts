import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("CancelReturnUseCase — ledger cancellation", () => {
  const mockReturnRepo = {
    cancel: vi.fn(),
  } as any;
  const mockLedgerRepo = {
    cancelByReference: vi.fn(),
  } as any;
  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls ledger.cancelByReference after cancelling return", async () => {
    const { CancelReturnUseCase } = await import(
      "@/application/use-cases/returns/CancelReturnUseCase"
    );
    const uc = new CancelReturnUseCase(mockReturnRepo, mockLedgerRepo);
    await uc.execute("ret-1" as UUID, ctx);
    expect(mockReturnRepo.cancel).toHaveBeenCalledWith("ret-1", ctx);
    expect(mockLedgerRepo.cancelByReference).toHaveBeenCalledWith("ret-1", ctx);
  });
});
