/**
 * CODEBASE_AUDIT_REPORT_hermes F-012 — an admin password reset applies the same 8-character floor as
 * the setup wizard's account password; a 6-character value used to be accepted.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { registerUserRoutes } from "@/presentation/routes/user.route.js";
import { createErrorHandler } from "@/infrastructure/http/middleware/error-handler.middleware.js";
import { logger } from "@/infrastructure/config/logger.js";

async function reset(password: string) {
  const update = vi.fn(async () => ({ id: "u" }));
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
  registerUserRoutes(
    router,
    { update } as never,
    { hash: async (p: string) => `h:${p}` },
    pass,
    pass,
    {} as never,
  );
  app.use("/api", router);
  app.use(createErrorHandler(logger));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/users/${randomUUID()}/reset-password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      },
    );
    return { status: res.status, updated: update.mock.calls.length };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("POST /users/:id/reset-password policy", () => {
  it("refuses a 6-character password without touching the user", async () => {
    const r = await reset("abc123");
    expect(r.status).toBe(422);
    expect(r.updated).toBe(0);
  });
  it("accepts an 8-character password", async () => {
    expect((await reset("abcd1234")).updated).toBe(1);
  });
});
