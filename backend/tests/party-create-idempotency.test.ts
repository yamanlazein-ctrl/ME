/**
 * Customers/Suppliers review — POST /customers (and /suppliers) honour the Idempotency-Key the web
 * client sends and REPLAYS after an ambiguous network error: the same key twice creates ONE party
 * (one opening journal), and the replay returns the first response. Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import express, { type RequestHandler } from "express";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ambientDb } from "@/infrastructure/orm/ambient-tx.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { registerPartyRoutes } from "@/presentation/routes/party.route.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "idem-party",
};
let server: Server;
let base = "";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: tenantId,
    name: "IdemParty",
    slug: `ip-${tenantId.slice(0, 8)}`,
  } as typeof tenants.$inferInsert);
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

const settle = () => new Promise((r) => setTimeout(r, 300)); // the response cache write is fire-and-forget

describe("POST /customers replay", () => {
  it("the same Idempotency-Key twice creates one customer and one opening journal", async () => {
    const key = randomUUID();
    const name = `عميل ${key.slice(0, 6)}`;
    const post = () =>
      fetch(`${base}/api/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          name,
          currency: "USD",
          openingAmount: 50,
          openingDirection: "they_owe_us",
          openingDate: "2026-09-01",
        }),
      });
    const first = await post();
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    await settle();
    const replay = await post();
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: string }).id).toBe(created.id);

    const rows = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), eq(parties.name, name)));
    expect(rows).toHaveLength(1);
    const opening = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.partyId, created.id)));
    expect(opening.length).toBeGreaterThan(0);
    expect(opening.length).toBeLessThanOrEqual(2); // one opening journal (party leg + equity leg)
  });
});
