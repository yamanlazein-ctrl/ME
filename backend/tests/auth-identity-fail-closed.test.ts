/**
 * CODEBASE_AUDIT_REPORT H-09 — when the users lookup fails, the auth middleware must not fall back to
 * the role inside the JWT (an inactive/demoted user would keep admin). It answers 503, retryable.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

vi.mock("../src/infrastructure/auth/sessionCutoff.js", async (orig) => ({
  ...(await orig<typeof import("../src/infrastructure/auth/sessionCutoff.js")>()),
  resolveSessionIdentity: vi.fn(async () => {
    throw new Error("permission denied for table users");
  }),
}));

const { createAuthMiddleware } =
  await import("../src/infrastructure/http/middleware/auth.middleware.js");

describe("auth middleware: identity lookup failure", () => {
  it("refuses with 503 instead of granting the token's role", async () => {
    const payload = {
      sub: randomUUID(),
      tenantId: randomUUID(),
      role: "admin",
      jti: randomUUID(),
      iat: 0,
    };
    const mw = createAuthMiddleware(
      { verifyAccessToken: async () => payload } as never,
      { has: async () => false } as never,
    );
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    const req = { headers: { authorization: "Bearer t" }, path: "/api/x" } as unknown as Request;
    const next = vi.fn();
    await mw(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect((req as Request & { tenantContext?: unknown }).tenantContext).toBeUndefined();
  });
});
