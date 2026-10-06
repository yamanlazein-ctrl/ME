/**
 * Customer/supplier delete safety: the impact sheet shows the last 10 related documents and states
 * EXACTLY what the delete does to the cash box and to the party balance.
 *
 * Fixture (one customer, USD):
 *   - opening balance leg 25.00 (no document) — a delete never touches it;
 *   - active sale INV-A 100.00, 40.00 collected in cash (ledger: AR debit 100, receipt credit 40 cash `in`);
 *   - a cancelled older sale INV-OLD — history, still listed, no effect;
 *   - 12 extra cancelled sales so "last 10" is a real cut.
 * Cascade delete cancels INV-A: the cash box loses 40.00 and the balance goes 85.00 → 25.00.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db, withTenantTx } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { computePartyDeletionImpact } from "@/infrastructure/repositories/partyDeletionImpact.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const plainId = randomUUID();
const activeInvoiceId = randomUUID();
let reachable = false;

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await db.insert(tenants).values({ id: tenantId, name: "Delete impact", slug: `dia-${tenantId.slice(0, 8)}` } as typeof tenants.$inferInsert);
  await db.insert(parties).values([
    { id: customerId, tenantId, kind: "customer", name: `عميل ${customerId.slice(0, 6)}`, currency: "USD", status: "active", version: 1 },
    { id: plainId, tenantId, kind: "customer", name: `عميل بلا حركات ${plainId.slice(0, 6)}`, currency: "USD", status: "active", version: 1 },
  ]);
  const inv = (id: string, number: string, date: string, status: string, total: number, paid: number) => ({
    id, tenantId, number, type: "sale", date, partyId: customerId, partyType: "customer", currency: "USD",
    subtotal: total, total, paid, status, version: 1,
  });
  await db.insert(invoices).values([
    inv(activeInvoiceId, "INV-A", "2026-05-10", "active", 100, 40),
    inv(randomUUID(), "INV-OLD", "2026-01-02", "cancelled", 70, 0),
    ...Array.from({ length: 12 }, (_, i) => inv(randomUUID(), `INV-H${String(i).padStart(2, "0")}`, `2026-02-${String(i + 1).padStart(2, "0")}`, "cancelled", 10, 0)),
  ] as (typeof invoices.$inferInsert)[]);
  const leg = (o: Partial<typeof ledgerEntries.$inferInsert>) =>
    ({ id: randomUUID(), tenantId, partyId: customerId, currency: "USD", status: "active", debit: 0, credit: 0, cashImpact: "none", ...o }) as typeof ledgerEntries.$inferInsert;
  await db.insert(ledgerEntries).values([
    leg({ date: "2026-01-01", type: "opening", debit: 25, referenceType: "opening", referenceId: customerId }),
    leg({ date: "2026-05-10", type: "sales_invoice", debit: 100, referenceType: "sales_invoice", referenceId: activeInvoiceId }),
    leg({ date: "2026-05-10", type: "receipt_in", credit: 40, cashImpact: "in", referenceType: "sales_invoice", referenceId: activeInvoiceId }),
  ]);
});

describe("party delete impact — recent activity and accounting effect", () => {
  it("lists the last 10 related documents, newest first, cancelled ones marked", async (t) => {
    skipUnlessDatabase(t, reachable);
    const impact = await withTenantTx(tenantId, (tx) => computePartyDeletionImpact(tx, tenantId, customerId));
    expect(impact.recentActivity).toHaveLength(10);
    expect(impact.recentActivity[0]!.number).toBe("INV-A");
    expect(impact.recentActivity[0]!.status).toBe("active");
    const dates = impact.recentActivity.map((d) => d.date!);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(impact.recentActivity.slice(1).every((d) => d.status === "cancelled" && d.label.includes("ملغاة"))).toBe(true);
  });

  it("states that the cascade takes the collected cash back out of the box and what the balance becomes", async (t) => {
    skipUnlessDatabase(t, reachable);
    const impact = await withTenantTx(tenantId, (tx) => computePartyDeletionImpact(tx, tenantId, customerId));
    expect(impact.requiresCascade).toBe(true);
    expect(impact.accounting.affectsCashbox).toBe(true);
    expect(impact.accounting.cashboxChange).toEqual([{ currency: "USD", amount: -40 }]);
    expect(impact.accounting.balanceNow).toEqual([{ currency: "USD", amount: 85 }]);
    // the opening balance is not a document: it survives the delete
    expect(impact.accounting.balanceAfter).toEqual([{ currency: "USD", amount: 25 }]);
    expect(impact.accounting.affectsBalance).toBe(true);
  });

  it("a party with nothing linked: no cash box or balance effect", async (t) => {
    skipUnlessDatabase(t, reachable);
    const impact = await withTenantTx(tenantId, (tx) => computePartyDeletionImpact(tx, tenantId, plainId));
    expect(impact.recentActivity).toEqual([]);
    expect(impact.accounting).toEqual({ balanceNow: [], balanceAfter: [], cashboxChange: [], affectsCashbox: false, affectsBalance: false });
  });
});
