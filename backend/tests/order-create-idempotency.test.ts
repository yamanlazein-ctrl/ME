/**
 * CODEBASE_AUDIT_REPORT_hermes F-010 — POST /orders must require an Idempotency-Key (428 without),
 * like every other document-creating POST. The middleware runs before the handler, so a fake
 * repository is enough: the request must never reach it.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { registerOrderRoutes } from "@/presentation/routes/order.route.js";

describe("POST /orders idempotency", () => {
  it("answers 428 IDEMPOTENCY_KEY_REQUIRED without a key and never calls the repository", async () => {
    const create = vi.fn();
    const pass: RequestHandler = (req, _res, next) => {
      (req as unknown as { tenantContext: unknown }).tenantContext = {
        tenantId: randomUUID(),
        userId: randomUUID(),
        userRole: "admin",
      };
      next();
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerOrderRoutes(router, { create } as never, pass, pass, pass);
    app.use("/api", router);
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orders`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partyId: randomUUID(), lines: [] }),
        },
      );
      expect(res.status).toBe(428);
      expect(((await res.json()) as { code: string }).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect(create).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
