import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { isTokenBeforeCutoff, revokeSubjectSessions } from "../src/infrastructure/auth/sessionCutoff.js";
import { db } from "../src/infrastructure/orm/drizzle.js";
import { config } from "../src/infrastructure/config/env.js";
import { createAuthMiddleware } from "../src/infrastructure/http/middleware/auth.middleware.js";
import { JwtSigner } from "../src/infrastructure/auth/JwtSigner.js";
import { runWithTenantContext, runWithPlatformContext } from "../src/infrastructure/orm/tenant-context.js";
import type { Request, Response, NextFunction } from "express";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

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
  let reachable = false;
  let tenantId = "";
  let userA = "";
  let userB = "";

  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    tenantId = randomUUID();
    userA = randomUUID();
    userB = randomUUID();
    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Session Cutoff Tenant', ${`sct-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
        on conflict (id) do nothing
      `);
    });
    await runWithTenantContext({ tenantId }, async () => {
      await db.execute(sql`
        insert into users (id, tenant_id, name, email, password_hash, role, active)
        values
          (${userA}, ${tenantId}, 'Cutoff A', ${`cutoff-a-${userA.slice(0, 8)}@test.local`}, 'x', 'admin', true),
          (${userB}, ${tenantId}, 'Cutoff B', ${`cutoff-b-${userB.slice(0, 8)}@test.local`}, 'x', 'admin', true)
      `);
    });
  });

  afterAll(async () => {
    if (!reachable || !tenantId) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from users where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("sets cutoff for one user and leaves the other user's column unchanged", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);

    await runWithTenantContext({ tenantId }, async () => {
      const beforeB = await db.execute<{ c: Date | null }>(sql`
        select tokens_revoked_before as c from users where id = ${userB}
      `);
      const cutoff = await revokeSubjectSessions(userA, tenantId);
      const afterA = await db.execute<{ c: Date | null }>(sql`
        select tokens_revoked_before as c from users where id = ${userA}
      `);
      const afterB = await db.execute<{ c: Date | null }>(sql`
        select tokens_revoked_before as c from users where id = ${userB}
      `);
      const aCutoff = (afterA.rows?.[0] as { c: Date | null } | undefined)?.c ?? null;
      const bBefore = (beforeB.rows?.[0] as { c: Date | null } | undefined)?.c ?? null;
      const bAfter = (afterB.rows?.[0] as { c: Date | null } | undefined)?.c ?? null;
      expect(aCutoff).not.toBeNull();
      expect(Math.abs(new Date(aCutoff!).getTime() - cutoff.getTime())).toBeLessThan(2000);
      expect(bAfter?.toString() ?? null).toBe(bBefore?.toString() ?? null);

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
});
