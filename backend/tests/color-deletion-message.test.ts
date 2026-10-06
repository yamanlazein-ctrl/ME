/**
 * Bug #4 — deleting a dye color must explain WHERE it is linked before it
 * refuses, and must then really delete it.
 *
 * The previous version of this file asserted that an exported string constant
 * matched two regexes. That proved nothing about behaviour: it passed even if
 * the impact query returned no links at all and the delete was unreachable.
 *
 * These cases drive `computeColorDeletionImpact` — the real function behind
 * `GET /inventory/colors/:id/deletion-impact`, the exact endpoint the confirm
 * dialog reads — against a live database, and assert the two things the user
 * actually asked for:
 *
 *   1. an unlinked color reports NO blockers and is deletable after confirm;
 *   2. a linked color names the concrete documents (invoice NUMBER, not a
 *      generic "لا يمكن حذف") and is refused.
 *
 * Postgres is required; without it the suite skips VISIBLY (never silently).
 */
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { randomUUID } from "node:crypto";
import { db, withTenantTx } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { computeColorDeletionImpact } from "@/infrastructure/repositories/rollDeletionHelper.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const freeColorId = randomUUID();
const linkedColorId = randomUUID();
const freeRollId = randomUUID();
const linkedRollId = randomUUID();
const partyId = randomUUID();
const invoiceId = randomUUID();
const INVOICE_NUMBER = "PC-2026-0042";

let reachable = false;

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await db.insert(tenants).values({
    id: tenantId,
    name: "Color Impact Tenant",
    slug: `ci-${tenantId.slice(0, 8)}`,
  });
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Dye Base" });
  await db.insert(colors).values([
    { id: freeColorId, tenantId, fabricId, name: "Red (unlinked)" },
    { id: linkedColorId, tenantId, fabricId, name: "Blue (linked)" },
  ]);
  await db.insert(rolls).values([
    { id: freeRollId, tenantId, colorId: freeColorId, rollNo: "R-FREE", initialKg: 10,
      remainingKg: 10, pieces: 1, remainingPieces: 1, pricePerKg: 1000, currency: "SYP", entryDate: "2026-02-01" },
    { id: linkedRollId, tenantId, colorId: linkedColorId, rollNo: "R-LINKED", initialKg: 10,
      remainingKg: 10, pieces: 1, remainingPieces: 1, pricePerKg: 1000, currency: "SYP", entryDate: "2026-02-01" },
  ]);
  await db.insert(parties).values({
    id: partyId,
    tenantId,
    name: "Impact Customer",
    kind: "customer",
    currency: "SYP",
  });
  await db.insert(invoices).values({
    id: invoiceId,
    tenantId,
    number: INVOICE_NUMBER,
    type: "entry",
    partyId,
    partyType: "supplier",
    status: "active",
    currency: "SYP",
    date: "2026-02-01",
    total: 100_000,
    paid: 0,
  });
  await db.insert(invoiceLines).values({
    id: randomUUID(),
    tenantId,
    invoiceId,
    rollId: linkedRollId,
    colorId: linkedColorId,
    fabricId,
    quantityKg: 10,
    pricePerKg: 10_000,
    lineTotal: 100_000,
  });
});

describe("color deletion impact (bug #4)", () => {
  it("an unlinked color reports no blockers and is safe to delete", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const impact = await withTenantTx(tenantId, (tx) =>
      computeColorDeletionImpact(tx, tenantId, freeColorId),
    );
    expect(impact.colorId).toBe(freeColorId);
    expect(impact.colorName).toBe("Red (unlinked)");
    expect(impact.rollsCount).toBe(1);
    expect(impact.invoiceRefs).toHaveLength(0);
    expect(impact.orderRefs).toHaveLength(0);
    expect(impact.returnRefs).toHaveLength(0);
    expect(impact.printJobRefs).toHaveLength(0);
    // No live document references it -> the confirm dialog offers the delete.
    expect(impact.canDelete).toBe(true);
  });

  it("a linked color names the exact invoice NUMBER and refuses the delete", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const impact = await withTenantTx(tenantId, (tx) =>
      computeColorDeletionImpact(tx, tenantId, linkedColorId),
    );
    expect(impact.canDelete).toBe(false);
    expect(impact.invoiceRefs).toHaveLength(1);
    // The user is told WHICH invoice, not just "cannot delete".
    expect(impact.invoiceRefs[0]!.id).toBe(invoiceId);
    expect(impact.invoiceRefs[0]!.label).toContain(INVOICE_NUMBER);
    // …and the same detail is rendered as confirm-dialog lines.
    expect(impact.summaryLines.join("\n")).toContain(INVOICE_NUMBER);
    expect(impact.summaryLines.length).toBeGreaterThan(0);
  });

  it("an unknown color is a typed COLOR_NOT_FOUND, not a generic failure", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await expect(
      withTenantTx(tenantId, (tx) =>
        computeColorDeletionImpact(tx, tenantId, randomUUID()),
      ),
    ).rejects.toMatchObject({ code: "COLOR_NOT_FOUND" });
  });

  it("impact is tenant-scoped: another tenant's color is not visible", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    const otherTenant = randomUUID();
    await db.insert(tenants).values({
      id: otherTenant,
      name: "Other Tenant",
      slug: `ot-${otherTenant.slice(0, 8)}`,
    });
    // The same color id queried under a different tenant must not resolve.
    await expect(
      withTenantTx(otherTenant, (tx) =>
        computeColorDeletionImpact(tx, otherTenant, freeColorId),
      ),
    ).rejects.toMatchObject({ code: "COLOR_NOT_FOUND" });
  });
});
