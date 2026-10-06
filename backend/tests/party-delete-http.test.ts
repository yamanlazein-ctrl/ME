/**
 * The party-delete HTTP contract, end to end over real HTTP.
 *
 * This is the layer where the reported bug lived. The desktop UI sends
 * `DELETE /api/customers/:id`; the route answers **204 with an empty body**; the
 * desktop transport used to throw on that response, treat it as a network
 * failure and replay the DELETE, and the replay came back 422 "تعارض في الإصدار
 * (الإصدار 2)" for a delete that had already succeeded. So the assertions that
 * matter here are the exact status codes and the exact number of mutations the
 * server performs.
 *
 * Runs against live Postgres with the real repositories and the real router.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
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
import { databaseReachable } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "http-delete-tester",
};

const INVOICE_COUNT = 130;
const PAGE_SIZE = 25;

let reachable = false;
let server: Server | null = null;
let base = "";
let customerId = "";
let plainCustomerId = "";

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;

  await db.insert(tenants).values({
    id: tenantId,
    name: "Party Delete HTTP",
    slug: `pdh-${tenantId.slice(0, 8)}`,
  } as typeof tenants.$inferInsert);

  customerId = randomUUID();
  plainCustomerId = randomUUID();
  await db.insert(parties).values([
    {
      id: customerId,
      tenantId,
      kind: "customer",
      name: `عميل ${customerId.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    },
    {
      id: plainCustomerId,
      tenantId,
      kind: "customer",
      name: `عميل بلا ارتباطات ${plainCustomerId.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    },
  ]);
  await db.insert(invoices).values(
    Array.from({ length: INVOICE_COUNT }, (_, i) => ({
      tenantId,
      partyId: customerId,
      partyType: "customer" as const,
      type: "sale" as const,
      number: `HTTP-${String(i + 1).padStart(4, "0")}`,
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

  const dbx = ambientDb(db);
  const app = express();
  app.use(express.json());
  // Stand in for the real auth chain: the route only needs a tenant context.
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
    undefined,
    new PostgresInvoiceRepository(dbx),
    new PostgresVoucherRepository(dbx),
  );
  app.use("/api", router);

  server = app.listen(0);
  const listening = Promise.withResolvers<void>();
  server.once("listening", () => listening.resolve());
  await listening.promise;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

describe("DELETE /api/customers/:id — status contract", () => {
  it("answers 204 with an empty body for a party with no links", async () => {
    if (!reachable) return;
    const res = await fetch(`${base}/api/customers/${plainCustomerId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const [row] = await db.select().from(parties).where(eq(parties.id, plainCustomerId));
    expect(row?.status).toBe("cancelled");
  });

  it("a REPLAY of that delete is 204 too, not 422 — this is the phantom OCC", async () => {
    if (!reachable) return;
    const res = await fetch(`${base}/api/customers/${plainCustomerId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      // Exactly what the client re-sent: the same stale expectedVersion.
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(204);
  });

  it("a genuinely stale version on an active party is still refused, with an honest message", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "customer",
      name: `عميل ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 2,
    });
    const res = await fetch(`${base}/api/customers/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("تعارض في الإصدار");
    expect(body.message).not.toContain("جلسة أخرى");
  });

  it("cascades every one of 130 invoices and answers 204", async () => {
    if (!reachable) return;
    const impact = (await (
      await fetch(`${base}/api/customers/${customerId}/deletion-impact`)
    ).json()) as { version: number; counts: { invoices: number } };
    expect(impact.counts.invoices).toBe(INVOICE_COUNT);

    const res = await fetch(`${base}/api/customers/${customerId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: impact.version, confirmCascade: true }),
    });
    expect(res.status).toBe(204);

    const [row] = await db.select().from(parties).where(eq(parties.id, customerId));
    expect(row?.status).toBe("cancelled");
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(eq(invoices.partyId, customerId));
    // All 130 rows still exist (a delete is a soft cancel) and NONE is active:
    // before the fix the cascade stopped at the impact sheet's 100-row cap.
    expect(n).toBe(INVOICE_COUNT);
    const [{ active }] = await db
      .select({ active: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(eq(invoices.partyId, customerId), eq(invoices.status, "active")));
    expect(active).toBe(0);
  });
});

describe("GET /api/customers/:id/linked-docs — reviewability", () => {
  it("pages through every document with an exact total", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "customer",
      name: `عميل استعراض ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    });
    await db.insert(invoices).values(
      Array.from({ length: 1000 }, (_, i) => ({
        tenantId,
        partyId: id,
        partyType: "customer" as const,
        type: "sale" as const,
        number: `BIG-${String(i + 1).padStart(5, "0")}`,
        date: "2026-09-03",
        currency: "USD",
        subtotal: 1,
        total: 1,
        paid: 0,
        status: "active" as const,
        version: 1,
        createdBy: ctx.userId,
      })),
    );

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let firstTotal = -1;
    for (;;) {
      const url = new URL(`${base}/api/customers/${id}/linked-docs`);
      url.searchParams.set("kind", "invoice");
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const page = (await res.json()) as {
        items: { id: string }[];
        total: number;
        nextCursor: string | null;
      };
      if (pages === 0) {
        firstTotal = page.total;
        expect(page.items).toHaveLength(PAGE_SIZE);
      }
      for (const item of page.items) seen.add(item.id);
      pages++;
      cursor = page.nextCursor;
      // The dialog stops the same way: the exact total ends the walk, so a last
      // page that exactly fills the limit costs no extra empty request.
      if (!cursor || seen.size >= page.total) break;
      if (pages > 60) throw new Error("paging did not terminate");
    }
    // 1000 documents: never materialised at once, never truncated, never repeated.
    expect(firstTotal).toBe(1000);
    expect(seen.size).toBe(1000);
    expect(pages).toBe(40);
  });

  it("searches by document number and rejects nonsense input", async () => {
    if (!reachable) return;

    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "customer",
      name: `عميل بحث ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    });
    await db.insert(invoices).values(
      Array.from({ length: 3 }, (_, i) => ({
        tenantId,
        partyId: id,
        partyType: "customer" as const,
        type: "sale" as const,
        number: `FIND-${i + 1}`,
        date: "2026-09-04",
        currency: "USD",
        subtotal: 5,
        total: 5,
        paid: 0,
        status: "active" as const,
        version: 1,
        createdBy: ctx.userId,
      })),
    );

    const found = await fetch(`${base}/api/customers/${id}/linked-docs?kind=invoice&q=FIND-2`);
    expect(found.status).toBe(200);
    const page = (await found.json()) as { total: number; items: { number: string }[] };
    expect(page.total).toBe(1);
    expect(page.items[0].number).toBe("FIND-2");

    // A free-text term is not a date: it must search, not blow up the query.
    const byText = await fetch(`${base}/api/customers/${id}/linked-docs?kind=invoice&q=find`);
    expect(byText.status).toBe(200);
    expect(((await byText.json()) as { total: number }).total).toBe(3);

    const badKind = await fetch(`${base}/api/customers/${id}/linked-docs?kind=ledger`);
    expect(badKind.status).toBeGreaterThanOrEqual(400);
    const badLimit = await fetch(`${base}/api/customers/${id}/linked-docs?kind=invoice&limit=5000`);
    expect(badLimit.status).toBeGreaterThanOrEqual(400);
  });

  it("a supplier has no open orders to review", async () => {
    if (!reachable) return;
    const id = randomUUID();
    await db.insert(parties).values({
      id,
      tenantId,
      kind: "supplier",
      name: `مورد ${id.slice(0, 8)}`,
      currency: "USD",
      status: "active",
      version: 1,
    });
    const res = await fetch(`${base}/api/suppliers/${id}/linked-docs?kind=order`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { total: number }).total).toBe(0);
  });
});
