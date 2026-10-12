/**
 * Customers/Suppliers review — PUT /customers/:id persists a CLEARED field as NULL (phone "" and a
 * blank email used to keep the old value: "" was stored as "" and a blank email was dropped by the
 * schema), and a stale expectedVersion is refused instead of overwriting. Engine-agnostic.
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
import { registerPartyRoutes } from "@/presentation/routes/party.route.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const partyId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "clear-tester",
};
let server: Server;
let base = "";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: tenantId,
    name: "Clear",
    slug: `clr-${tenantId.slice(0, 8)}`,
  } as typeof tenants.$inferInsert);
  await db.insert(parties).values({
    id: partyId,
    tenantId,
    kind: "customer",
    name: "عميل",
    currency: "USD",
    status: "active",
    version: 1,
    phone: "0999",
    email: "old@x.co",
    address: "حلب",
    notes: "قديمة",
  });
  const app = express();
  app.use(express.json());
  const auth: RequestHandler = (req, _res, next) => {
    (req as unknown as { tenantContext: TenantContext }).tenantContext = ctx;
    next();
  };
  const router = express.Router();
  registerPartyRoutes(router, new PostgresPartyRepository(ambientDb(db)), auth, auth, auth);
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const put = (body: Record<string, unknown>) =>
  fetch(`${base}/api/customers/${partyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const row = async () => (await db.select().from(parties).where(eq(parties.id, partyId)))[0]!;

describe("PUT /customers/:id", () => {
  it("clears phone, email, address and notes", async () => {
    const res = await put({
      name: "عميل",
      phone: "",
      email: "",
      address: "",
      notes: "",
      expectedVersion: 1,
    });
    expect(res.status).toBe(200);
    const r = await row();
    expect([r.phone, r.email, r.address, r.notes]).toEqual([null, null, null, null]);
  });

  it("refuses a stale version without changing the record", async () => {
    const res = await put({ name: "اسم من جلسة قديمة", expectedVersion: 1 });
    expect(res.status).toBe(422);
    expect((await row()).name).toBe("عميل");
  });
});
