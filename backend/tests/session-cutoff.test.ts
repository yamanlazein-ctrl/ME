import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { isTokenBeforeCutoff, revokeSubjectSessions } from "../src/infrastructure/auth/sessionCutoff.js";
import { pool } from "../src/infrastructure/orm/drizzle.js";
import { config } from "../src/infrastructure/config/env.js";
import { createAuthMiddleware } from "../src/infrastructure/http/middleware/auth.middleware.js";
import { JwtSigner } from "../src/infrastructure/auth/JwtSigner.js";
import type { Request, Response, NextFunction } from "express";

describe("per-subject token cutoff", () => {
  it("refuses iat strictly before cutoff and accepts iat on/after cutoff", () => {
    const cutoff = new Date("2026-09-13T12:00:00.000Z");
    const before = Math.floor(cutoff.getTime() / 1000) - 30;
    const after = Math.floor(cutoff.getTime() / 1000) + 30;
    expect(isTokenBeforeCutoff(before, cutoff)).toBe(true);
    expect(isTokenBeforeCutoff(after, cutoff)).toBe(false);
    expect(isTokenBeforeCutoff(Math.floor(cutoff.getTime() / 1000), cutoff)).toBe(false);
    expect(isTokenBeforeCutoff(after, null)).toBe(false);
    expect(isTokenBeforeCutoff(undefined, cutoff)).toBe(false);
  });

  it("does not treat another user's missing cutoff as revoked", () => {
    expect(isTokenBeforeCutoff(1_000_000_000, null)).toBe(false);
  });
});

describe("revokeSubjectSessions on live postgres", () => {
  let tenantId = "";
  let userA = "";
  let userB = "";
  let previousA: Date | null = null;

  beforeAll(async () => {
    await pool.query("select 1");
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_revoked_before timestamptz`);
    const t = await pool.query<{ id: string }>(`SELECT id::text AS id FROM tenants LIMIT 1`);
    tenantId = t.rows[0]?.id ?? "";
    if (!tenantId) throw new Error("no tenant on live postgres");
    await pool.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);
    const users = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE tenant_id = $1 AND active = true LIMIT 2`,
      [tenantId],
    );
    if (users.rows.length < 2) throw new Error("need two active users for cutoff isolation test");
    userA = users.rows[0]!.id;
    userB = users.rows[1]!.id;
    const prev = await pool.query<{ c: Date | null }>(
      `SELECT tokens_revoked_before AS c FROM users WHERE id = $1`,
      [userA],
    );
    previousA = prev.rows[0]?.c ?? null;
  });

  afterAll(async () => {
    if (!userA) return;
    await pool.query(`UPDATE users SET tokens_revoked_before = $2 WHERE id = $1`, [
      userA,
      previousA,
    ]);
  });

  it("sets cutoff for one user and leaves the other user's column unchanged", async () => {
    const beforeB = await pool.query<{ c: Date | null }>(
      `SELECT tokens_revoked_before AS c FROM users WHERE id = $1`,
      [userB],
    );
    const cutoff = await revokeSubjectSessions(userA, tenantId);
    const afterA = await pool.query<{ c: Date | null }>(
      `SELECT tokens_revoked_before AS c FROM users WHERE id = $1`,
      [userA],
    );
    const afterB = await pool.query<{ c: Date | null }>(
      `SELECT tokens_revoked_before AS c FROM users WHERE id = $1`,
      [userB],
    );
    expect(afterA.rows[0]?.c).not.toBeNull();
    expect(Math.abs(new Date(afterA.rows[0]!.c!).getTime() - cutoff.getTime())).toBeLessThan(2000);
    expect(afterB.rows[0]?.c?.toString() ?? null).toBe(beforeB.rows[0]?.c?.toString() ?? null);

    const secret = new TextEncoder().encode(config.JWT_SECRET);
    const iatBefore = Math.floor(cutoff.getTime() / 1000) - 30;
    const iatAfter = Math.floor(Date.now() / 1000) + 5;
    const oldToken = await new SignJWT({
      sub: userA,
      tenantId,
      role: "admin",
      jti: "11111111-1111-4111-8111-111111111111",
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(iatBefore)
      .setExpirationTime(iatAfter + 3600)
      .sign(secret);
    const newToken = await new SignJWT({
      sub: userA,
      tenantId,
      role: "admin",
      jti: "22222222-2222-4222-8222-222222222222",
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(iatAfter)
      .setExpirationTime(iatAfter + 3600)
      .sign(secret);

    const mw = createAuthMiddleware(new JwtSigner(), {
      has: async () => false,
      add: async () => undefined,
      delete: async () => undefined,
    });
    const run = (token: string) =>
      new Promise<{ status: number; code?: string }>((resolve) => {
        const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
        const res = {
          status(n: number) {
            this.statusCode = n;
            return this;
          },
          json(body: { code?: string }) {
            resolve({ status: this.statusCode ?? 200, code: body.code });
            return this;
          },
          statusCode: 200,
        } as unknown as Response & { statusCode: number };
        const next: NextFunction = () => resolve({ status: 200 });
        void mw(req, res, next);
      });

    const refused = await run(oldToken);
    expect(refused.status).toBe(401);
    expect(refused.code).toBe("SESSION_REVOKED");
    const accepted = await run(newToken);
    expect(accepted.status).toBe(200);
  });
});
