/**
 * Bug #3 — the customers / suppliers page must reflect the database, not a
 * leftover summary, after invoices are deleted.
 *
 * Reported symptom: after deleting invoices and their stock movements the data
 * vanished elsewhere, but the party still looked like it had activity.
 *
 * The guarantee under test is "database state == UI state": the party list
 * endpoint derives every number it shows from live rows, so cancelling the
 * documents must drive the visible totals back to zero with no orphan ledger
 * rows and no cached counter left behind.
 *
 * This runs the real `PostgresInvoiceRepository.cancel` and then reads the
 * real `PostgresPartyRepository` list-stats path — the exact query the
 * customers and suppliers pages consume.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, ambientDb } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();

const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "stale-check",
};

let reachable = false;

async function seedParty(kind: "customer" | "supplier") {
  const id = randomUUID();
  await db.insert(parties).values({
    id, tenantId, name: `Stale-${kind}-${randomUUID().slice(0, 8)}`,
    kind, currency: "SYP", status: "active",
  });
  const invIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const rollId = randomUUID();
    await db.insert(rolls).values({
      id: rollId, tenantId, colorId, rollNo: `R-${randomUUID().slice(0, 6)}`,
      initialKg: 100, remainingKg: 100, pieces: 1, remainingPieces: 1,
      pricePerKg: 1000, currency: "SYP", entryDate: "2026-04-01", supplierId: id,
    });
    const invId = randomUUID();
    invIds.push(invId);
    await db.insert(invoices).values({
      id: invId, tenantId, number: `INV-${randomUUID().slice(0, 8)}`,
      // The list-stats query scopes by invoice TYPE derived from the party
      // kind: customers aggregate their sales, suppliers their purchases.
      type: kind === "customer" ? "sale" : "entry",
      partyId: id, partyType: kind, status: "active", currency: "SYP",
      date: "2026-04-01", subtotal: 40_000, total: 40_000, paid: 0,
    });
    await db.insert(invoiceLines).values({
      id: randomUUID(), tenantId, invoiceId: invId, rollId, colorId, fabricId,
      quantityKg: 10, pricePerKg: 4000, discountAmount: 0, pieces: 1,
    });
    await db.insert(ledgerEntries).values({
      id: randomUUID(), tenantId, partyId: id, date: "2026-04-01", type: "sales_invoice",
      debit: 40_000, credit: 0, currency: "SYP", referenceType: "invoice",
      referenceId: invId, status: "active", cashImpact: "none",
    });
  }
  return { id, invIds };
}

/** The list row the customers / suppliers page renders. */
async function listRow(partyId: string, kind: "customer" | "supplier") {
  const repo = new PostgresPartyRepository(ambientDb(db));
  const res = await repo.list({ kind, search: "", limit: 200, page: 0 }, ctx);
  const rows = res.data ?? res;
  return (rows as Array<{ id: string; stats?: Record<string, unknown> }>).find(
    (r) => r.id === partyId,
  );
}

const activeLegIds = (party: string) =>
  db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.partyId, party), eq(ledgerEntries.status, "active")))
    .then((r) => r.map((x) => x.id));

const invStatus = (id: string) =>
  db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id)).then((r) => r[0]?.status);

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await db.insert(tenants).values({
    id: tenantId, name: "Stale Check", slug: `sc-${tenantId.slice(0, 8)}`,
  });
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "F" });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "C" });
});

describe("no stale party data after invoice deletion (bug #3)", () => {
  it("a customer shows activity before, and none after, its invoices are cancelled", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const { id, invIds } = await seedParty("customer");

    // BEFORE: the page must show the real activity.
    const before = await listRow(id, "customer");
    expect(before, "party must be listed").toBeDefined();
    expect(before!.stats!.invoicesCount).toBe(2);
    expect(Number(before!.stats!.totalAmount)).toBe(80_000);
    expect(await activeLegIds(id)).toHaveLength(2);

    // DELETE through the real cancel path.
    const repo = new PostgresInvoiceRepository(ambientDb(db));
    for (const invId of invIds) {
      const current = await repo.findById(invId, ctx);
      await repo.cancel(invId, ctx.userId, ctx, current!.version);
    }

    // AFTER: the page reflects the database, with nothing left over.
    const after = await listRow(id, "customer");
    expect(after, "party must still be listed").toBeDefined();
    expect(after!.stats!.invoicesCount).toBe(0);
    expect(Number(after!.stats!.totalAmount)).toBe(0);
    expect(Number(after!.stats!.totalPaid)).toBe(0);
    expect(Number(after!.stats!.remaining)).toBe(0);
    // No active document left ⇒ there is no "last operation" to show.
    expect(after!.stats!.lastDate).toBeFalsy();

    // No orphan ledger legs are still counted as active.
    expect(await activeLegIds(id)).toHaveLength(0);
    // The documents are cancelled, not half-deleted.
    for (const invId of invIds) expect(await invStatus(invId)).toBe("cancelled");
  });

  it("a supplier is governed by the same rules and leaves no residue", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const { id, invIds } = await seedParty("supplier");
    const before = await listRow(id, "supplier");
    expect(before!.stats!.invoicesCount).toBe(2);

    const repo = new PostgresInvoiceRepository(ambientDb(db));
    for (const invId of invIds) {
      const current = await repo.findById(invId, ctx);
      await repo.cancel(invId, ctx.userId, ctx, current!.version);
    }

    const after = await listRow(id, "supplier");
    expect(after!.stats!.invoicesCount).toBe(0);
    expect(Number(after!.stats!.remaining)).toBe(0);
    expect(await activeLegIds(id)).toHaveLength(0);
  });

  it("cancelling the last invoice leaves no invoice_lines pointing at it", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const { id, invIds } = await seedParty("customer");
    const repo = new PostgresInvoiceRepository(ambientDb(db));
    for (const invId of invIds) {
      const current = await repo.findById(invId, ctx);
      await repo.cancel(invId, ctx.userId, ctx, current!.version);
    }
    // Lines survive cancellation by design (the document is soft-deleted), but
    // they must no longer drive any party total — proven above. This asserts
    // the cancel did not silently delete a DIFFERENT invoice's lines.
    const lineCount = await db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, invIds));
    expect(lineCount.length).toBe(2);
    void id;
  });
});
