/**
 * D-4 / FR-017 (specs/001-desktop-sqlite-engine): cancelled customers and
 * suppliers are hidden from normal operational lists — including the default
 * "all" view (no status filter) — while staying stored and reachable for
 * audit/history: by id, and through an explicit `status: "cancelled"` filter.
 *
 * Runs the real `PostgresPartyRepository` against the test database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "d4-check" };
const ids = { activeCustomer: randomUUID(), cancelledCustomer: randomUUID(), inactiveCustomer: randomUUID(), cancelledSupplier: randomUUID() };
let reachable = false;

describe("D-4 — cancelled parties hidden from operational lists", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await db.insert(tenants).values({ id: tenantId, name: "D4 tenant", slug: `d4-${tenantId.slice(0, 8)}` });
    const row = (id: string, kind: "customer" | "supplier", status: "active" | "inactive" | "cancelled", name: string) => ({
      id, tenantId, kind, status, name: `${name}-${id.slice(0, 6)}`, currency: "SYP",
    });
    await db.insert(parties).values([
      row(ids.activeCustomer, "customer", "active", "Active"),
      row(ids.cancelledCustomer, "customer", "cancelled", "Cancelled"),
      row(ids.inactiveCustomer, "customer", "inactive", "Inactive"),
      row(ids.cancelledSupplier, "supplier", "cancelled", "CancelledSup"),
    ]);
  });

  const repo = () => new PostgresPartyRepository(db);

  it("default customer list ('all' view) excludes cancelled but keeps active and inactive", async (t) => {
    skipUnlessDatabase(t, reachable);
    const res = await repo().list({ kind: "customer", limit: 1000 }, ctx);
    const got = res.data.map((p) => p.id);
    expect(got).toContain(ids.activeCustomer);
    expect(got).toContain(ids.inactiveCustomer);
    expect(got).not.toContain(ids.cancelledCustomer);
  });

  it("default supplier list excludes cancelled", async (t) => {
    skipUnlessDatabase(t, reachable);
    const res = await repo().list({ kind: "supplier", limit: 1000 }, ctx);
    expect(res.data.map((p) => p.id)).not.toContain(ids.cancelledSupplier);
  });

  it("default list without a kind excludes cancelled parties of both kinds", async (t) => {
    skipUnlessDatabase(t, reachable);
    const res = await repo().list({ limit: 1000 }, ctx);
    const got = res.data.map((p) => p.id);
    expect(got).not.toContain(ids.cancelledCustomer);
    expect(got).not.toContain(ids.cancelledSupplier);
  });

  it("the total reported with the default list does not count cancelled parties", async (t) => {
    skipUnlessDatabase(t, reachable);
    const res = await repo().list({ kind: "customer", limit: 1 }, ctx);
    expect(res.meta.total).toBe(2);
  });

  it("an explicit status=cancelled filter still returns them (audit/history)", async (t) => {
    skipUnlessDatabase(t, reachable);
    const res = await repo().list({ kind: "customer", status: "cancelled", limit: 1000 }, ctx);
    expect(res.data.map((p) => p.id)).toEqual([ids.cancelledCustomer]);
  });

  it("a cancelled party still resolves by id for historical documents", async (t) => {
    skipUnlessDatabase(t, reachable);
    const p = await repo().findById(ids.cancelledCustomer, ctx);
    expect(p?.id).toBe(ids.cancelledCustomer);
    expect(p?.status).toBe("cancelled");
  });
});
