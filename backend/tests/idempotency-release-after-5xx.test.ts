/**
 * CODEBASE_AUDIT_REPORT M-04 — a request that ended in a 5xx must release its in-flight claim, so the
 * client's retry with the same Idempotency-Key runs instead of 409 DUPLICATE_IN_FLIGHT for 5 minutes.
 * A 2xx stays cached and replayed. Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import express from "express";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { idempotency } from "@/infrastructure/http/middleware/idempotency-handler.middleware.js";

const tenantId = randomUUID();
let server: Server;
let base = "";
let failNext = true;
let runs = 0;

beforeAll(async () => {
  await db.execute(sql`select 1`);
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "Idem", slug: `idem-${tenantId.slice(0, 8)}` });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId,
      userId: randomUUID(),
      userRole: "admin",
    };
    next();
  });
  app.post("/op", idempotency("POST"), (_req, res) => {
    runs++;
    if (failNext) {
      failNext = false;
      res.status(503).json({ code: "UNAVAILABLE" });
      return;
    }
    res.status(201).json({ ok: true, run: runs });
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (key: string) =>
  fetch(`${base}/op`, {
    method: "POST",
    headers: { "Idempotency-Key": key, "Content-Type": "application/json" },
    body: "{}",
  });
const settle = () => new Promise((r) => setTimeout(r, 300)); // the finish handler's write is fire-and-forget

describe("idempotency claim after a failed request", () => {
  it("a retry after a 503 runs the handler again; the success is then replayed", async () => {
    const key = randomUUID();
    expect((await post(key)).status).toBe(503);
    await settle();
    const retry = await post(key);
    expect(retry.status).toBe(201);
    await settle();
    const replay = await post(key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replay")).toBe("true");
    expect(runs).toBe(2);
  });
});
