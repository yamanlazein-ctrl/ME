/**
 * Regression: a multi-invoice settlement sent with ONE Idempotency-Key must
 * create N vouchers. The key used to be stamped verbatim on every voucher's
 * client_operation_id (unique per tenant), so the 2nd voucher failed and the
 * whole settlement rolled back. Each voucher now gets a derived id; a replay
 * of the same key must still be refused rather than paying twice.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresAuditRepository } from "@/infrastructure/repositories/PostgresAuditRepository.js";
import { settleInvoicesUseCase } from "@/application/use-cases/statements/settleInvoicesUseCase.js";
import { deriveOperationId } from "@/infrastructure/utils/operationId.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();

async function mkInvoice(total: number): Promise<string> {
  const id = randomUUID();
  await db.insert(invoices).values({
    id, tenantId, number: `SCO-${id.slice(0, 6)}`, type: "sale", date: "2026-09-20",
    partyId: customerId, partyType: "customer", currency: "USD", exchangeRate: 1,
    subtotal: total, total, paid: 0, status: "active",
  } as never);
  return id;
}

const repos = () =>
  [new PostgresVoucherRepository(db), new PostgresAuditRepository(db), new PostgresPartyRepository(db)] as const;

describe("deriveOperationId", () => {
  it("is deterministic, uuid-shaped, and salt-specific", () => {
    const base = randomUUID();
    const a = deriveOperationId(base, "inv:1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveOperationId(base, "inv:1")).toBe(a);
    expect(deriveOperationId(base, "inv:2")).not.toBe(a);
    expect(deriveOperationId(null, "x")).toBeNull();
  });
});

describe("settle-invoices with one client operation id", () => {
  beforeAll(async () => {
    await db.insert(tenants).values({ id: tenantId, name: "SCO", slug: `sco-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId, tenantId, name: "SCO C", code: "SCO", kind: "customer", currency: "USD",
    });
  });

  it("creates one voucher per invoice and refuses a replay of the same key", async () => {
    const ids = [await mkInvoice(100), await mkInvoice(100)];
    const ctx = {
      tenantId, userId: randomUUID(), userRole: "admin", userName: "t",
      clientOperationId: randomUUID(),
    } as TenantContext;
    const input = { invoiceIds: ids, amountPaid: 150, currency: "USD" as const, exchangeRate: 1, date: "2026-09-20" };

    const r = await settleInvoicesUseCase(...repos(), customerId, "customer", input, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.vouchers).toHaveLength(2);

    const replay = await settleInvoicesUseCase(...repos(), customerId, "customer", input, ctx).catch(
      (e: unknown) => ({ ok: false as const, error: String(e) }),
    );
    expect(replay.ok).toBe(false);

    const active = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.status, "active")));
    expect(active).toHaveLength(2);
  });

  it("overpayment advance voucher gets its own id too", async () => {
    const ids = [await mkInvoice(40), await mkInvoice(40)];
    const ctx = {
      tenantId, userId: randomUUID(), userRole: "admin", userName: "t",
      clientOperationId: randomUUID(),
    } as TenantContext;
    const r = await settleInvoicesUseCase(
      ...repos(), customerId, "customer",
      { invoiceIds: ids, amountPaid: 100, currency: "USD", exchangeRate: 1, date: "2026-09-20" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.vouchers).toHaveLength(3);
      expect(r.data.advance?.amount).toBe(20);
    }
  });
});
