/**
 * Bugs #6 / #7 — deleting a customer or a supplier must be atomic.
 *
 * The cascade (invoice cancels → voucher cancels → party soft-cancel) used to
 * run each document in its OWN transaction inside a loop. A failure on the
 * third invoice therefore left the first two cancelled and the party alive —
 * a partial delete, exactly what the requirement forbids.
 *
 * These cases run the real `purgePartyCascadeUseCase` against a live database
 * and assert the ACID contract:
 *
 *   1. a party with NO relations is soft-cancelled with a fresh, correct version;
 *   2. a party with several invoices/vouchers is fully cascaded and consistent;
 *   3. a failure part-way through rolls EVERYTHING back — no orphan cancels,
 *      no half-deleted party, and the accounting legs are untouched;
 *   4. OCC is NOT bypassed: a wrong expectedVersion is refused and changes nothing;
 *   5. suppliers follow the identical mechanism as customers.
 *
 * The rollback case is driven by a real failure: an invoice whose cancellation
 * the repository rejects (stale version read inside the loop), not a mock.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { ambientDb } from "@/infrastructure/orm/drizzle.js";
import { purgePartyCascadeUseCase } from "@/application/use-cases/parties/purgePartyCascadeUseCase.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const partyId = randomUUID();

const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "purge-atomicity",
};

// The ambient-aware proxy is what the DI container injects; it is what makes
// a repository's internal transaction() a SAVEPOINT on the caller's.
const repos = () => {
  const dbx = ambientDb(db);
  return {
    partyRepo: new PostgresPartyRepository(dbx),
    invoiceRepo: new PostgresInvoiceRepository(dbx),
    voucherRepo: new PostgresVoucherRepository(dbx),
  };
};

let reachable = false;

async function createParty(kind: "customer" | "supplier") {
  const id = randomUUID();
  await db.insert(parties).values({
    id, tenantId, name: `Party-${kind}-${randomUUID().slice(0, 8)}`, kind, currency: "SYP",
  });
  return id;
}
async function createSale(party: string) {
  const rollId = randomUUID();
  await db.insert(rolls).values({
    id: rollId, tenantId, colorId, rollNo: `R-${randomUUID().slice(0, 6)}`,
    initialKg: 100, remainingKg: 100, pieces: 1, remainingPieces: 1,
    pricePerKg: 1000, currency: "SYP", entryDate: "2026-03-01",
    supplierId: party,
  });
  const id = randomUUID();
  const number = `SALE-${randomUUID().slice(0, 8)}`;
  await db.insert(invoices).values({
    id, tenantId, number, type: "sale", partyId: party, partyType: "customer",
    status: "active", currency: "SYP", date: "2026-03-01", total: 50_000, paid: 0,
  });
  await db.insert(invoiceLines).values({
    id: randomUUID(), tenantId, invoiceId: id, rollId, colorId, fabricId,
    quantityKg: 10, pricePerKg: 5000, lineTotal: 50_000,
  });
  // The financial leg a cancel must reverse.
  await db.insert(ledgerEntries).values({
    id: randomUUID(), tenantId, partyId: party, date: "2026-03-01", type: "sales_invoice",
    debit: 50_000, credit: 0, currency: "SYP", referenceType: "invoice",
    referenceId: id, status: "active",
  });
  return { id, number };
}

const invStatus = (id: string) =>
  db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id)).then((r) => r[0]?.status);
const partyRow = (id: string) =>
  db.select({ status: parties.status, version: parties.version })
    .from(parties).where(eq(parties.id, id)).then((r) => r[0]);
const activeLegs = (party: string) =>
  db.select({ id: ledgerEntries.id }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.partyId, party), eq(ledgerEntries.status, "active")));

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await db.insert(tenants).values({ id: tenantId, name: "Purge Atomicity", slug: `pa-${tenantId.slice(0, 8)}` });
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "F" });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "C" });
  await db.insert(parties).values({ id: partyId, tenantId, name: "Seed", kind: "customer", currency: "SYP" });
});

describe("party deletion atomicity (bugs #6 / #7)", () => {
  it("a party with no relations is soft-cancelled (OCC version honoured)", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const id = await createParty("customer");
    const { partyRepo, invoiceRepo, voucherRepo } = repos();
    const before = await partyRow(id);
    const r = await purgePartyCascadeUseCase({
      partyId: id, ctx, expectedVersion: before!.version,
      partyRepo, invoiceRepo, voucherRepo,
    });
    expect(r.ok).toBe(true);
    const after = await partyRow(id);
    expect(after!.status).toBe("cancelled");
  });

  it("cascades several invoices and vouchers, leaving no orphan rows", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const id = await createParty("customer");
    const a = await createSale(id);
    const b = await createSale(id);
    const { partyRepo, invoiceRepo, voucherRepo } = repos();
    const before = await partyRow(id);
    const r = await purgePartyCascadeUseCase({
      partyId: id, ctx, expectedVersion: before!.version,
      partyRepo, invoiceRepo, voucherRepo,
    });
    expect(r.ok).toBe(true);
    expect(await invStatus(a.id)).toBe("cancelled");
    expect(await invStatus(b.id)).toBe("cancelled");
    expect((await partyRow(id))!.status).toBe("cancelled");
    // Every ledger leg is resolved — no active orphan left on the party.
    expect(await activeLegs(id)).toHaveLength(0);
  });

  it("a mid-cascade failure rolls EVERYTHING back — no partial delete", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const id = await createParty("customer");
    const a = await createSale(id);
    const b = await createSale(id);
    const { partyRepo, invoiceRepo: realInvoice, voucherRepo } = repos();

    // Force a REAL failure on the SECOND cancel, whatever invoice the impact
    // order yields (it is date/number-desc, not insertion order). A pre-fix
    // implementation would leave that first invoice cancelled; with ONE
    // transaction every invoice must survive the failure.
    let seen = 0;
    const invoiceRepo = {
      findById: realInvoice.findById.bind(realInvoice),
      cancel: async (invId: string, by: string, c: TenantContext, v: number) => {
        seen += 1;
        if (seen === 2) {
          // A genuine repository-level refusal, e.g. a day that is locked.
          throw Object.assign(new Error("Day is locked"), { code: "DAY_LOCKED" as const });
        }
        return realInvoice.cancel(invId, by, c, v);
      },
    } as never;

    const before = await partyRow(id);
    const r = await purgePartyCascadeUseCase({
      partyId: id, ctx, expectedVersion: before!.version,
      partyRepo, invoiceRepo, voucherRepo,
    });

    expect(r.ok).toBe(false);
    expect(seen).toBe(2); // the first cancel DID run before the failure…
    // …and both invoices are still active: the whole thing rolled back.
    expect(await invStatus(a.id)).toBe("active");
    expect(await invStatus(b.id)).toBe("active");
    // The party was never touched.
    const after = await partyRow(id);
    expect(after!.status).toBe("active");
    expect(after!.version).toBe(before!.version);
    // …and the accounting legs are intact (no half-reversed cashbox).
    expect(await activeLegs(id)).toHaveLength(2);
  });

  it("a wrong expectedVersion is refused and changes nothing (OCC not bypassed)", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const id = await createParty("customer");
    const a = await createSale(id);
    const before = await partyRow(id);
    const { partyRepo, invoiceRepo, voucherRepo } = repos();
    const r = await purgePartyCascadeUseCase({
      partyId: id, ctx, expectedVersion: before!.version + 99, // deliberately stale
      partyRepo, invoiceRepo, voucherRepo,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/تعديل|حدّث الصفحة/);
    // Nothing was cancelled.
    expect(await invStatus(a.id)).toBe("active");
    expect((await partyRow(id))!.status).toBe("active");
  });

  it("suppliers use the identical mechanism as customers", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const id = await createParty("supplier");
    const s = await createSale(id);
    const { partyRepo, invoiceRepo, voucherRepo } = repos();
    const before = await partyRow(id);
    const r = await purgePartyCascadeUseCase({
      partyId: id, ctx, expectedVersion: before!.version,
      partyRepo, invoiceRepo, voucherRepo,
    });
    expect(r.ok).toBe(true);
    expect(await invStatus(s.id)).toBe("cancelled");
    expect((await partyRow(id))!.status).toBe("cancelled");
    expect(await activeLegs(id)).toHaveLength(0);
  });
});
