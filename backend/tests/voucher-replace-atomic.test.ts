/**
 * VERIFIED_REMEDIATION_PLAN ERP-008 — amending a voucher is ONE transaction: cancel the original and
 * create the replacement together. A refused replacement (unknown party, stale version) must leave the
 * original ACTIVE — the form used to cancel first and create in a second request, so a refused create
 * removed the original's financial effect with nothing in its place. Real engine repos + real route.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { buildContainer } from "@/infrastructure/di/container.js";
import { registerVoucherRoutes } from "@/presentation/routes/voucher.route.js";

const tenantId = randomUUID();
const customerId = randomUUID();
let base = "";

const receipt = (over: Record<string, unknown> = {}) => ({
  kind: "receipt",
  date: "2026-09-20",
  partyId: customerId,
  partyKind: "customer",
  amount: 100,
  currency: "USD",
  method: "cash",
  ...over,
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, body: json };
}

const statusOf = async (id: string) =>
  (
    await db
      .select({ status: vouchers.status, version: vouchers.version, amount: vouchers.amount })
      .from(vouchers)
      .where(and(eq(vouchers.id, id), eq(vouchers.tenantId, tenantId)))
  )[0];

describe("voucher amend = one transaction", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "E8", slug: `e8-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "C",
      code: "E8-C",
      kind: "customer",
      currency: "USD",
    });
    const c = buildContainer();
    const auth: RequestHandler = (req, _res, next) => {
      (req as unknown as { tenantContext: unknown }).tenantContext = {
        tenantId,
        userId: randomUUID(),
        userRole: "admin",
        userName: "e8",
      };
      next();
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerVoucherRoutes(
      router,
      c.voucherRepo,
      c.auditRepo,
      auth,
      auth,
      auth,
      c.syncOutboxRepo,
      c.partyRepo,
    );
    app.use("/api", router);
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
        res.status(500).json({ error: String((err as Error)?.stack ?? err) });
      },
    );
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it("a refused replacement or a stale version keeps the original active", async () => {
    const made = await post("/receipts", receipt());
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    const v = (await statusOf(id))!.version;

    const unknownParty = await post(`/receipts/${id}/replace`, {
      expectedVersion: v,
      voucher: receipt({ partyId: randomUUID(), amount: 90 }),
    });
    expect(unknownParty.status).toBe(422);
    expect((await statusOf(id))?.status).toBe("active");

    const stale = await post(`/receipts/${id}/replace`, {
      expectedVersion: v + 7,
      voucher: receipt({ amount: 90 }),
    });
    expect(stale.status).toBe(422);
    expect((await statusOf(id))?.status).toBe("active");
  });

  it("a valid amend cancels the original and creates the replacement together", async () => {
    const made = await post("/receipts", receipt());
    const id = made.body.id as string;
    const r = await post(`/receipts/${id}/replace`, {
      expectedVersion: (await statusOf(id))!.version,
      voucher: receipt({ amount: 80 }),
    });
    expect(r.status).toBe(201);
    expect((await statusOf(id))?.status).toBe("cancelled");
    const replacement = await statusOf(r.body.id as string);
    expect(replacement?.status).toBe("active");
    expect(Number(replacement?.amount)).toBe(80);
  });

  it("the route refuses a payment id on the receipts path", async () => {
    const pay = await post("/receipts", receipt());
    const r = await post(`/payments/${pay.body.id as string}/replace`, {
      expectedVersion: 1,
      voucher: receipt({ partyKind: "supplier" }),
    });
    expect(r.status).toBe(422);
    expect((await statusOf(pay.body.id as string))?.status).toBe("active");
  });
});
