import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, inArray, eq } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle";
import { revokedTokens } from "@/infrastructure/orm/schemas/revoked-token.table";
import {
  DbTokenDenylist,
  CompositeTokenDenylist,
  RedisTokenDenylist,
  type TokenDenylist,
} from "@/infrastructure/auth/TokenDenylist";

/**
 * P0-004 — the token denylist must work with **no Redis**.
 *
 * Before the fix, revocation lived only in Redis. `DESKTOP_DEPLOY` ships a
 * bundled PostgreSQL and no Redis, so `RedisTokenDenylist` was constructed with
 * `redis = null` and every method returned safely — i.e. did nothing. Logout,
 * admin revocation and device revocation all left access and refresh tokens
 * valid until their natural expiry, which is a silent security hole on exactly
 * the deployment the user needs to run fully offline.
 *
 * These tests exercise the REAL classes against the REAL `revoked_tokens` table
 * and assert the durable path is what makes revocation work. The Redis fast path
 * is stubbed so the suite proves it is an optimisation, not a requirement.
 */

const durable = new DbTokenDenylist();

/** Every jti this file creates, so it can clean up after itself. */
const createdJtis: string[] = [];

function newJti(): string {
  const jti = randomUUID();
  createdJtis.push(jti);
  return jti;
}

/** Minimal stand-in for ioredis — records calls, never talks to a network. */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly setexCalls: { key: string; ttl: number; value: string }[] = [];
  failMode = false;

  async setex(key: string, ttl: number, value: string): Promise<"OK"> {
    if (this.failMode) throw new Error("redis down");
    this.setexCalls.push({ key, ttl, value });
    this.store.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    if (this.failMode) throw new Error("redis down");
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    if (this.failMode) throw new Error("redis down");
    return this.store.delete(key) ? 1 : 0;
  }
}

/** A fast path whose every method throws — simulates Redis being unreachable. */
const brokenFastPath: TokenDenylist = {
  async add() {
    throw new Error("redis unreachable");
  },
  async has() {
    throw new Error("redis unreachable");
  },
  async delete() {
    throw new Error("redis unreachable");
  },
};

beforeAll(async () => {
  const probe = await db.execute(sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'revoked_tokens'
  `);
  const rows = (probe as unknown as { rows: unknown[] }).rows ?? [];
  if (rows.length === 0) {
    throw new Error(
      "revoked_tokens is missing — run `npm run db:migrate` (migration 0052) against the test database first.",
    );
  }
});

afterAll(async () => {
  if (createdJtis.length > 0) {
    await db.delete(revokedTokens).where(inArray(revokedTokens.jti, createdJtis));
  }
});

describe("P0-004 · revoked_tokens provisioning", () => {
  it("exists in the database with the expected columns", async () => {
    const res = await db.execute(sql`
      select column_name, is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'revoked_tokens'
      order by column_name
    `);
    const cols = ((res as unknown as { rows: { column_name: string }[] }).rows ?? []).map(
      (r) => r.column_name,
    );
    expect(cols).toEqual(["created_at", "expires_at", "jti", "reason", "subject", "tenant_id"]);
  });

  it("is deliberately NOT RLS-managed (readable before a tenant context exists)", async () => {
    const res = await db.execute(sql`
      select c.relrowsecurity as rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'revoked_tokens'
    `);
    const rows = (res as unknown as { rows: { rls: boolean }[] }).rows ?? [];
    expect(rows).toHaveLength(1);
    // The auth middleware checks every bearer token — including on routes that
    // resolve the tenant FROM the token. A tenant-scoped policy would hide the
    // row on those checkouts and the revocation would silently fail.
    expect(rows[0].rls).toBe(false);
  });
});

describe("P0-004 · DbTokenDenylist (durable path, no Redis)", () => {
  it("revokes and un-revokes a jti", async () => {
    const jti = newJti();
    expect(await durable.has(jti)).toBe(false);

    await durable.add(jti, 3600, { reason: "logout" });
    expect(await durable.has(jti)).toBe(true);

    await durable.delete(jti);
    expect(await durable.has(jti)).toBe(false);
  });

  it("records the reason, subject and tenant for audit", async () => {
    const jti = newJti();
    const subject = randomUUID();
    const tenantId = randomUUID();

    await durable.add(jti, 3600, { reason: "device-revoke", subject, tenantId });

    const row = await db
      .select()
      .from(revokedTokens)
      .where(eq(revokedTokens.jti, jti))
      .limit(1);

    expect(row).toHaveLength(1);
    expect(row[0].reason).toBe("device-revoke");
    expect(row[0].subject).toBe(subject);
    expect(row[0].tenantId).toBe(tenantId);
  });

  it("stops honouring a revocation once the token itself has expired", async () => {
    const jti = newJti();
    await durable.add(jti, 3600);
    expect(await durable.has(jti)).toBe(true);

    // Rewind the expiry to the past: the token can no longer be replayed, so
    // the row is dead weight and must not be reported as revoked.
    await db
      .update(revokedTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(revokedTokens.jti, jti));
    expect(await durable.has(jti)).toBe(false);
  });

  it("sweeps expired rows away", async () => {
    const jti = newJti();
    await durable.add(jti, 3600);
    await db
      .update(revokedTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(revokedTokens.jti, jti));

    const removed = await durable.sweepExpired();
    expect(removed).toBeGreaterThanOrEqual(1);

    const after = await db.select().from(revokedTokens).where(eq(revokedTokens.jti, jti));
    expect(after).toHaveLength(0);
  });

  it("is idempotent — re-revoking the same jti updates instead of throwing", async () => {
    const jti = newJti();
    await durable.add(jti, 60, { reason: "logout" });
    await durable.add(jti, 120, { reason: "reuse-detected" });

    const rows = await db.select().from(revokedTokens).where(eq(revokedTokens.jti, jti));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("reuse-detected");
  });
});

describe("P0-004 · CompositeTokenDenylist (the wiring the container uses)", () => {
  it("revokes with NO Redis configured at all — the DESKTOP_DEPLOY case", async () => {
    // `redis` is null on a desktop install, so the container builds exactly this.
    const denylist = new CompositeTokenDenylist(new DbTokenDenylist(), null);
    const jti = newJti();

    await denylist.add(jti, 3600, { reason: "logout" });
    expect(await denylist.has(jti)).toBe(true);

    await denylist.delete(jti);
    expect(await denylist.has(jti)).toBe(false);
  });

  it("still revokes when the Redis fast path is unreachable", async () => {
    const denylist = new CompositeTokenDenylist(new DbTokenDenylist(), brokenFastPath);
    const jti = newJti();

    // add() must not reject just because Redis is down.
    await expect(denylist.add(jti, 3600, { reason: "logout" })).resolves.toBeUndefined();
    // has() must fall through to the durable table.
    expect(await denylist.has(jti)).toBe(true);
  });

  it("honours a revocation written while Redis was down (DB is the source of truth)", async () => {
    const fake = new FakeRedis();
    const denylist = new CompositeTokenDenylist(new DbTokenDenylist(), new RedisTokenDenylist(fake as never));
    const jti = newJti();

    await denylist.add(jti, 3600);
    // Wipe Redis: only the durable row survives.
    fake.store.clear();
    expect(await denylist.has(jti)).toBe(true);
  });
});

describe("P0-004 · RedisTokenDenylist unit contract", () => {
  it("passes SECONDS to setex — not milliseconds", async () => {
    const fake = new FakeRedis();
    const denylist = new RedisTokenDenylist(fake as never);

    await denylist.add(randomUUID(), 60);

    expect(fake.setexCalls).toHaveLength(1);
    // Regression guard: the licence path used to pass `30 * 24 * 60 * 60 * 1000`
    // here, which setex read as seconds -> a ~82-year TTL instead of 30 days.
    expect(fake.setexCalls[0].ttl).toBe(60);
  });

  it("never sets a TTL below 1 second (setex rejects 0)", async () => {
    const fake = new FakeRedis();
    const denylist = new RedisTokenDenylist(fake as never);

    await denylist.add(randomUUID(), 0);

    expect(fake.setexCalls).toHaveLength(1);
    expect(fake.setexCalls[0].ttl).toBe(1);
  });

  it("documents the pre-fix behaviour it replaced: a null Redis revoked nothing", async () => {
    const denylist = new RedisTokenDenylist(null);
    const jti = randomUUID();

    await denylist.add(jti, 3600);
    // This is the old DESKTOP_DEPLOY behaviour — always false, no revocation.
    expect(await denylist.has(jti)).toBe(false);
  });
});
