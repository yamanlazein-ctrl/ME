/**
 * List screens now filter and page on the SERVER instead of downloading full
 * histories. These lock the server rules to the old client-side ones:
 *  - central ledger (keepOpening): opening entries bypass type/date/status,
 *    search matches description OR reference number;
 *  - voucher/return lists carry the linked invoice number (no invoice download).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresLedgerRepository } from "@/infrastructure/repositories/PostgresLedgerRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();
const ctx = { tenantId, userId: randomUUID(), userRole: "admin", userName: "t" } as TenantContext;

beforeAll(async () => {
  await db.insert(tenants).values({ id: tenantId, name: "LF", slug: `lf-${tenantId.slice(0, 8)}` });
  await db.insert(parties).values({ id: partyId, tenantId, name: "LF C", code: "LFC", kind: "customer", currency: "USD" } as never);
  await db.insert(invoices).values({
    id: invoiceId, tenantId, number: "INV-LF-777", type: "sale", date: "2026-07-01",
    partyId, partyType: "customer", currency: "USD", exchangeRate: 1, subtotal: 50, total: 50, paid: 0, status: "active",
  } as never);
  const le = (over: Record<string, unknown>) => ({
    tenantId, partyId, currency: "USD", debit: 10, credit: 0, description: "حركة", ...over,
  });
  await db.insert(ledgerEntries).values([
    le({ date: "2025-01-01", type: "opening", description: "رصيد افتتاحي" }),
    le({ date: "2026-07-01", type: "sales_invoice", referenceNumber: "INV-LF-777" }),
    le({ date: "2026-07-02", type: "receipt_in", status: "cancelled" }),
    le({ date: "2026-01-01", type: "sales_invoice" }),
  ] as never);
  await db.insert(vouchers).values({
    tenantId, kind: "receipt", number: "RCP-LF-1", date: "2026-07-03", partyId, partyKind: "customer",
    invoiceId, amount: 20, currency: "USD", method: "cash",
  } as never);
});

describe("central ledger server filters (keepOpening)", () => {
  const repo = new PostgresLedgerRepository(db);
  const list = (f: Record<string, unknown>) =>
    repo.list({ partyId, keepOpening: true, limit: 100, ...f } as never, ctx);

  it("date window keeps the opening entry", async () => {
    const r = await list({ fromDate: "2026-06-01" });
    expect(r.data.map((e) => e.type).sort()).toEqual(["opening", "receipt_in", "sales_invoice"]);
  });

  it("type + status filters keep the opening entry", async () => {
    const r = await list({ type: "receipt_in", status: "active" });
    expect(r.data.map((e) => e.type)).toEqual(["opening"]);
  });

  it("search matches the reference number", async () => {
    const r = await list({ search: "lf-777" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.type).toBe("sales_invoice");
  });

  it("without keepOpening the window applies to opening too (other callers unchanged)", async () => {
    const r = await repo.list({ partyId, fromDate: "2026-06-01", limit: 100 } as never, ctx);
    expect(r.data.some((e) => e.type === "opening")).toBe(false);
  });
});

describe("voucher list carries the linked invoice number", () => {
  it("invoiceNumber on each row", async () => {
    const r = await new PostgresVoucherRepository(db).list({ partyId, limit: 10 } as never, ctx);
    expect(r.data[0]?.invoiceNumber).toBe("INV-LF-777");
  });
});
