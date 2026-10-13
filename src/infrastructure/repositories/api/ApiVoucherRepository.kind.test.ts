/**
 * VERIFIED_REMEDIATION_PLAN ERP-006 — a receipt looked up by id comes back from GET /payments/:id
 * (the server does not filter by kind); it must stay a receipt for a customer, or the receipt edit
 * form refuses to hydrate.
 */
import { describe, it, expect } from "vitest";
import { ApiVoucherRepository } from "./ApiVoucherRepository";

const dto = (kind: "payment" | "receipt", partyKind: "customer" | "supplier") => ({
  id: "v-1",
  number: "R-1",
  kind,
  partyKind,
  date: "2026-10-01",
  partyId: "p-1",
  amount: 10,
  currency: "USD",
  method: "cash",
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
  version: 1,
});

describe("ApiVoucherRepository keeps the server's voucher kind", () => {
  it("a receipt returned by /payments/:id stays a customer receipt", async () => {
    const api = { findPaymentById: async () => dto("receipt", "customer") };
    const v = await new ApiVoucherRepository(api as never).findById("v-1" as never, {} as never);
    expect(v?.kind).toBe("receipt");
    expect(v?.partyKind).toBe("customer");
  });

  it("a payment stays a supplier payment", async () => {
    const api = { findPaymentById: async () => dto("payment", "supplier") };
    const v = await new ApiVoucherRepository(api as never).findById("v-1" as never, {} as never);
    expect(v?.kind).toBe("payment");
    expect(v?.partyKind).toBe("supplier");
  });
});
