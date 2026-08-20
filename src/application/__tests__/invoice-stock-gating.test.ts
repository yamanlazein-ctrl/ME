import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";
import type { IInvoiceRepository } from "@/application/ports/IInvoiceRepository";
import type { Invoice } from "@/domain/entities/Invoice";

const TID = "00000000-0000-0000-0000-000000000001" as UUID;
const PID = "00000000-0000-0000-0000-000000000002" as UUID;
const FID = "00000000-0000-0000-0000-000000000003" as UUID;
const CID = "00000000-0000-0000-0000-000000000004" as UUID;
const RID = "00000000-0000-0000-0000-000000000005" as UUID;
const LID = "00000000-0000-0000-0000-000000000006" as UUID;
const IID = "00000000-0000-0000-0000-000000000007" as UUID;
const UID = "00000000-0000-0000-0000-000000000008" as UUID;

const mockInvoiceRepo = {
  create: vi.fn(),
  findById: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
};

const ctx: TenantContext = {
  tenantId: TID,
  userId: UID,
  userRole: "admin",
  userName: "tester",
};

async function getCreateInvoice() {
  const { CreateInvoiceUseCase } = await import("@/application/use-cases/invoices/CreateInvoice");
  return new CreateInvoiceUseCase(mockInvoiceRepo as unknown as IInvoiceRepository);
}

async function getCancelInvoice() {
  const { CancelInvoiceUseCase } = await import("@/application/use-cases/invoices/CancelInvoice");
  return new CancelInvoiceUseCase(mockInvoiceRepo as unknown as IInvoiceRepository);
}

function savedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: IID,
    number: "PO-3001",
    type: "sale",
    date: "2026-01-15",
    partyId: PID,
    partyType: "customer",
    currency: "SYP",
    lines: [{ rollId: RID, quantityKg: 10, pricePerKg: 5000 }],
    total: () => 50000,
    ...overrides,
  } as unknown as Invoice;
}

const baseInput = {
  tenantId: TID,
  number: "PO-3001",
  type: "sale" as const,
  date: "2026-01-15",
  partyId: PID,
  partyType: "customer" as const,
  currency: "SYP" as const,
  subtotal: 0,
  discount: 0,
  tax: 0,
  total: 0,
  lines: [
    {
      id: LID,
      fabricId: FID,
      colorId: CID,
      rollId: RID,
      quantityKg: 10,
      pricePerKg: 5000,
      discountAmount: 0,
    },
  ],
  notes: undefined,
};

describe("CreateInvoiceUseCase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockInvoiceRepo.create.mockResolvedValue(savedInvoice());
  });

  it("persists the invoice through the repository", async () => {
    const uc = await getCreateInvoice();
    const result = await uc.execute(baseInput, ctx);
    expect(result.ok).toBe(true);
    expect(mockInvoiceRepo.create).toHaveBeenCalledTimes(1);
    const arg = mockInvoiceRepo.create.mock.calls[0][0];
    expect(arg.type).toBe("sale");
    expect(arg.tenantId).toBe(TID);
    expect(arg.createdBy).toBe(UID);
  });

  it("rejects input without a party", async () => {
    const uc = await getCreateInvoice();
    const result = await uc.execute({ ...baseInput, partyId: "" as UUID }, ctx);
    expect(result.ok).toBe(false);
    expect(mockInvoiceRepo.create).not.toHaveBeenCalled();
  });

  it("rejects input without lines", async () => {
    const uc = await getCreateInvoice();
    const result = await uc.execute({ ...baseInput, lines: [] }, ctx);
    expect(result.ok).toBe(false);
    expect(mockInvoiceRepo.create).not.toHaveBeenCalled();
  });

  it("rejects lines with zero quantity", async () => {
    const uc = await getCreateInvoice();
    const result = await uc.execute(
      { ...baseInput, lines: [{ ...baseInput.lines[0], quantityKg: 0 }] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(mockInvoiceRepo.create).not.toHaveBeenCalled();
  });
});

describe("CancelInvoiceUseCase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("cancels an active invoice through the repository", async () => {
    mockInvoiceRepo.findById
      .mockResolvedValueOnce(savedInvoice({ status: "active", canCancel: () => true }))
      .mockResolvedValueOnce(savedInvoice({ status: "cancelled" }));
    mockInvoiceRepo.cancel.mockResolvedValue(undefined);

    const uc = await getCancelInvoice();
    const result = await uc.execute(IID, ctx);
    expect(result.ok).toBe(true);
    expect(mockInvoiceRepo.cancel).toHaveBeenCalledWith(IID, ctx);
  });

  it("rejects cancelling an invoice that cannot be cancelled", async () => {
    mockInvoiceRepo.findById.mockResolvedValue(
      savedInvoice({ status: "cancelled", canCancel: () => false }),
    );

    const uc = await getCancelInvoice();
    const result = await uc.execute(IID, ctx);
    expect(result.ok).toBe(false);
    expect(mockInvoiceRepo.cancel).not.toHaveBeenCalled();
  });

  it("returns NotFoundError when the invoice does not exist", async () => {
    mockInvoiceRepo.findById.mockResolvedValue(null);

    const uc = await getCancelInvoice();
    const result = await uc.execute(IID, ctx);
    expect(result.ok).toBe(false);
    expect(mockInvoiceRepo.cancel).not.toHaveBeenCalled();
  });
});
