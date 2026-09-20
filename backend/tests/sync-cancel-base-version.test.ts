/**
 * Cancel-replay optimistic concurrency (behaviour test).
 *
 * Reproduces the defect this guard fixes: a cancel unit that carries no base
 * version used to be replayed by falling back to the hub row's CURRENT version,
 * so a cancel issued offline against v2 silently voided v3 — an edit another
 * device had already applied. That is a blind last-write-wins kill of a
 * financial document, forbidden by the convergence rules.
 *
 * The materializers take repositories through `SyncMaterializeRepos`, so the
 * test injects in-memory fakes: no database is required, and the assertions
 * are about the DECISION (refuse vs apply) plus the version actually handed to
 * the domain use-case. The conflict row write (`recordSyncConflict`) is
 * best-effort by design (it swallows storage errors) and is asserted
 * structurally in tests/sync-invariants.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { materializeSyncUnit } from "../src/application/use-cases/sync/syncMaterialize.js";
import type { SyncMaterializeRepos } from "../src/application/use-cases/sync/syncMaterialize.js";
import { runWithTenantContext } from "../src/infrastructure/orm/tenant-context.js";
import type { TenantContext } from "../src/domain/types/index.js";
import type { InvoiceData } from "../src/domain/entities/Invoice.js";
import type { VoucherData } from "../src/domain/entities/Voucher.js";

const ctx: TenantContext = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  userRole: "accountant",
  userName: "tester",
};

const OP_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Production always reaches a materializer inside a tenant scope: the auth
 * middleware opens `runWithTenantContext` for every request, and the inbox
 * drain inherits it. `recordSyncConflict` fails closed without that scope
 * (DFP-019), so the harness must reproduce it instead of calling the
 * materializer bare — otherwise the test exercises a state production never
 * has.
 */
function inTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenantId: ctx.tenantId }, fn);
}
const INVOICE_ID = "44444444-4444-4444-8444-444444444444";
const VOUCHER_ID = "55555555-5555-4555-8555-555555555555";

function invoiceRow(version: number, status: "active" | "cancelled"): InvoiceData {
  return {
    id: INVOICE_ID,
    number: "INV-2026-0001",
    type: "sale",
    status,
    version,
    lines: [],
    total: 0,
  } as unknown as InvoiceData;
}

function voucherRow(version: number, status: "active" | "cancelled"): VoucherData {
  return {
    id: VOUCHER_ID,
    number: "VOC-2026-0001",
    kind: "payment",
    status,
    version,
  } as unknown as VoucherData;
}

/** Minimal repositories for the two cancel branches under test. */
function makeRepos(overrides: {
  invoice?: InvoiceData | null;
  voucher?: VoucherData | null;
  cancelInvoice?: ReturnType<typeof vi.fn>;
  cancelVoucher?: ReturnType<typeof vi.fn>;
}): SyncMaterializeRepos {
  const cancelInvoice =
    overrides.cancelInvoice ??
    vi.fn(async () => invoiceRow((overrides.invoice?.version ?? 1) + 1, "cancelled"));
  const cancelVoucher =
    overrides.cancelVoucher ??
    vi.fn(async () => voucherRow((overrides.voucher?.version ?? 1) + 1, "cancelled"));
  return {
    invoiceRepo: {
      findById: async () => overrides.invoice ?? null,
      cancel: cancelInvoice,
    },
    voucherRepo: {
      findById: async () => overrides.voucher ?? null,
      cancel: cancelVoucher,
    },
    auditRepo: { create: async () => undefined },
  } as unknown as SyncMaterializeRepos;
}

const database = {} as never;

describe("cancel replay — stale base is refused, not applied blind", () => {
  it("invoice: base v2 vs hub v3 → failed, cancel never called", async () => {
    const cancelInvoice = vi.fn();
    const repos = makeRepos({
      invoice: invoiceRow(3, "active"),
      cancelInvoice,
    });

    const result = await inTenantScope(() =>
      materializeSyncUnit(
        database,
        repos,
        {
          entityType: "invoice",
          operation: "cancel",
          payload: { invoiceId: INVOICE_ID, baseVersion: 2 },
        },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("تعارض إلغاء");
    expect(result.error).toContain("v3");
    expect(cancelInvoice, "a stale cancel must never reach the domain cancel").not.toHaveBeenCalled();
  });

  it("voucher: stale base is refused through the same shared guard", async () => {
    const cancelVoucher = vi.fn();
    const repos = makeRepos({
      voucher: voucherRow(4, "active"),
      cancelVoucher,
    });

    const result = await inTenantScope(() =>
      materializeSyncUnit(
        database,
        repos,
        {
          entityType: "voucher",
          operation: "cancel",
          payload: { voucherId: VOUCHER_ID, baseVersion: 1 },
        },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("تعارض إلغاء");
    expect(cancelVoucher).not.toHaveBeenCalled();
  });

  it("matching base is applied with the CALLER's version, not the hub's", async () => {
    const cancelInvoice = vi.fn(async () => invoiceRow(3, "cancelled"));
    const repos = makeRepos({
      invoice: invoiceRow(2, "active"),
      cancelInvoice,
    });

    const result = await inTenantScope(() =>
      materializeSyncUnit(
        database,
        repos,
        {
          entityType: "invoice",
          operation: "cancel",
          payload: { invoiceId: INVOICE_ID, baseVersion: 2 },
        },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      ),
    );

    expect(result.status).toBe("created");
    expect(cancelInvoice).toHaveBeenCalledTimes(1);
    // arguments: (id, cancelledBy, ctx, expectedVersion)
    expect(cancelInvoice.mock.calls[0]![3]).toBe(2);
  });

  it("duplicate delivery of an already-cancelled invoice converges to exists", async () => {
    const cancelInvoice = vi.fn();
    const repos = makeRepos({
      invoice: invoiceRow(3, "cancelled"),
      cancelInvoice,
    });

    const result = await inTenantScope(() =>
      materializeSyncUnit(
        database,
        repos,
        {
          entityType: "invoice",
          operation: "cancel",
          payload: { invoiceId: INVOICE_ID, baseVersion: 2 },
        },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      ),
    );

    // Idempotency wins over the stale check: the intent is already satisfied,
    // so a redelivery is `exists` (not a conflict) and the cursor advances.
    expect(result.status).toBe("exists");
    expect(cancelInvoice).not.toHaveBeenCalled();
  });

  it("payload without a base version is refused (no silent cancel)", async () => {
    const cancelInvoice = vi.fn(async () => invoiceRow(2, "cancelled"));
    const repos = makeRepos({
      invoice: invoiceRow(1, "active"),
      cancelInvoice,
    });

    const result = await inTenantScope(() =>
      materializeSyncUnit(
        database,
        repos,
        {
          entityType: "invoice",
          operation: "cancel",
          payload: { invoiceId: INVOICE_ID },
        },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      ),
    );

    expect(result.status).toBe("failed");
    expect(cancelInvoice).not.toHaveBeenCalled();
  });
});
