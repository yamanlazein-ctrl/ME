/**
 * CODEBASE_AUDIT_REPORT H-10 — DELETE /customers/:id with confirmCascade:
 *  - the cascade and its sync units commit together: an outbox failure rolls the purge back and the
 *    route does not answer 204 (it used to log the failure after the purge had committed);
 *  - every cancelled invoice gets its own cancel unit, before the party delete, so the hub can replay.
 * Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import express, { type RequestHandler } from "express";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ambientDb } from "@/infrastructure/orm/ambient-tx.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { registerPartyRoutes } from "@/presentation/routes/party.route.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "h10-tester",
};
const units: { entityType: string; operation: string; entityId: string }[] = [];
let failEnqueue = false;
const outbox = {
  enqueue: async (u: { entityType: string; operation: string; entityId: string }) => {
    if (failEnqueue) throw new Error("outbox unavailable");
    units.push({ entityType: u.entityType, operation: u.operation, entityId: u.entityId });
  },
};

let server: Server;
let base = "";

async function partyWithInvoices(n: number) {
  const id = randomUUID();
  await db.insert(parties).values({
    id,
    tenantId,
    kind: "customer",
    name: `C ${id.slice(0, 6)}`,
    currency: "USD",
    status: "active",
    version: 1,
  });
  await db.insert(invoices).values(
    Array.from({ length: n }, (_, i) => ({
      tenantId,
      partyId: id,
      partyType: "customer" as const,
      type: "sale" as const,
      number: `H10-${id.slice(0, 4)}-${i}`,
      date: "2026-09-02",
      currency: "USD",
      subtotal: 10,
      total: 10,
      paid: 0,
      status: "active" as const,
      version: 1,
      createdBy: ctx.userId,
    })),
  );
  return id;
}

const purge = (id: string) =>
  fetch(`${base}/api/customers/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, confirmCascade: true }),
  });
const statusOf = async (id: string) =>
  (await db.select({ s: parties.status }).from(parties).where(eq(parties.id, id)))[0]!.s;
const activeInvoices = async (id: string) =>
  (await db.select({ s: invoices.status }).from(invoices).where(eq(invoices.partyId, id))).filter(
    (r) => r.s === "active",
  ).length;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: tenantId,
    name: "H10",
    slug: `h10-${tenantId.slice(0, 8)}`,
  } as typeof tenants.$inferInsert);
  const dbx = ambientDb(db);
  const app = express();
  app.use(express.json());
  const auth: RequestHandler = (req, _res, next) => {
    (req as unknown as { tenantContext: TenantContext }).tenantContext = ctx;
    next();
  };
  const router = express.Router();
  registerPartyRoutes(
    router,
    new PostgresPartyRepository(dbx),
    auth,
    auth,
    auth,
    outbox as never,
    new PostgresInvoiceRepository(dbx),
    new PostgresVoucherRepository(dbx),
  );
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("party cascade purge + sync outbox", () => {
  it("an outbox failure rolls the whole purge back and is not answered 204", async () => {
    const id = await partyWithInvoices(3);
    failEnqueue = true;
    const res = await purge(id);
    failEnqueue = false;
    expect(res.status).not.toBe(204);
    expect(await statusOf(id)).toBe("active");
    expect(await activeInvoices(id)).toBe(3);
  });

  it("enqueues one cancel per invoice, then the party delete, in the purge's transaction", async () => {
    const id = await partyWithInvoices(2);
    units.length = 0;
    const res = await purge(id);
    expect(res.status).toBe(204);
    expect(await statusOf(id)).toBe("cancelled");
    expect(units.map((u) => `${u.entityType}:${u.operation}`)).toEqual([
      "invoice:cancel",
      "invoice:cancel",
      "party:delete",
    ]);
    expect(units.at(-1)!.entityId).toBe(id);
  });
});
