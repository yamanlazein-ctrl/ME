/**
 * Party merge (OLD-PLAN 3.4) — locks the observable result so the move behind
 * IPartyRepository.mergeInto (S1) and the SQLite twin (S4) can be held to it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, ambientDb } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { mergePartiesUseCase } from "@/application/use-cases/parties/mergePartiesUseCase.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "merge-check" };
const survivor = randomUUID();
const source = randomUUID();
const supplier = randomUUID();
const invoiceId = randomUUID();
let reachable = false;
const repo = () => new PostgresPartyRepository(ambientDb(db));

describe("party merge", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await db.insert(tenants).values({ id: tenantId, name: "Merge tenant", slug: `mrg-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: survivor, tenantId, kind: "customer", status: "active", name: "Survivor", code: "S-1", currency: "SYP" },
      { id: source, tenantId, kind: "customer", status: "active", name: "Duplicate", code: "D-1", currency: "SYP" },
      { id: supplier, tenantId, kind: "supplier", status: "active", name: "A supplier", code: "SP-1", currency: "SYP" },
    ]);
    await db.insert(invoices).values({
      id: invoiceId, tenantId, number: `INV-M-${invoiceId.slice(0, 6)}`, type: "sale", partyId: source, partyType: "customer",
      status: "active", currency: "SYP", date: "2026-05-01", subtotal: 500, total: 500, paid: 0,
    });
    await db.insert(ledgerEntries).values({
      id: randomUUID(), tenantId, partyId: source, date: "2026-05-01", type: "sales_invoice", debit: 500, credit: 0,
      currency: "SYP", cashImpact: "none", referenceType: "sales_invoice", referenceId: invoiceId, status: "active",
    });
  });

  it("refuses to merge a party into itself or across kinds", async (t) => {
    skipUnlessDatabase(t, reachable);
    await expect(mergePartiesUseCase(repo(), survivor, survivor, ctx)).rejects.toThrow();
    await expect(mergePartiesUseCase(repo(), survivor, supplier, ctx)).rejects.toThrow();
  });

  it("moves invoices and ledger to the survivor and soft-cancels the source", async (t) => {
    skipUnlessDatabase(t, reachable);
    const r = await mergePartiesUseCase(repo(), survivor, source, ctx);
    expect(r).toEqual({ survivorId: survivor, sourceId: source, moved: { invoices: 1, vouchers: 0, returns: 0, ledger: 1 } });

    const [inv] = await db.select({ partyId: invoices.partyId }).from(invoices).where(eq(invoices.id, invoiceId));
    expect(inv?.partyId).toBe(survivor);
    const led = await db.select({ partyId: ledgerEntries.partyId }).from(ledgerEntries).where(eq(ledgerEntries.referenceId, invoiceId));
    expect(led.map((l) => l.partyId)).toEqual([survivor]);

    const [src] = await db.select().from(parties).where(and(eq(parties.id, source), eq(parties.tenantId, tenantId)));
    expect(src?.status).toBe("cancelled");
    expect(src?.code).toBe("D-1-MERGED");
    expect(src?.name.startsWith("Duplicate [")).toBe(true);
  });

  it("refuses to merge an already-cancelled source again", async (t) => {
    skipUnlessDatabase(t, reachable);
    await expect(mergePartiesUseCase(repo(), survivor, source, ctx)).rejects.toThrow();
  });
});
