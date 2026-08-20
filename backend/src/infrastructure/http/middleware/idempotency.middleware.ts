import { Redis } from "ioredis";
import { redis } from "../../auth/TokenDenylist.js";
import { pool } from "../../orm/drizzle.js";

/**
 * Idempotency-Key service for POST endpoints.
 *
 * Contract:
 *   - Client sends header `Idempotency-Key: <string>` (recommended: UUID).
 *   - Server caches the response under that key for IDEMPOTENCY_TTL_SECONDS.
 *   - If the same key arrives again within the TTL, the cached response is
 *     returned (status+body bytes) and the handler is NOT executed again.
 *   - If no key is provided, the handler runs normally (no idempotency).
 *
 * Storage:
 *   - Primary: Redis (if available) using SETEX with TTL.
 *   - Fallback: the `idempotency_keys` Postgres table (migration 0014).
 *
 * Fix C-6 (forensic audit 2026-08-15): the fallback used to be an
 * in-memory `Map`, scoped to a single Node process. Behind any
 * multi-replica deployment, two duplicate POSTs (e.g. a double-clicked
 * "create invoice" button, or a client-side retry) landing on different
 * processes each saw an empty Map, each claimed successfully, and BOTH
 * committed — two invoices, two stock deductions, two full ledger sets,
 * from one user action. This defeated the documented "Redis SET NX"
 * idempotency guarantee under precisely the conditions idempotency
 * exists for. Migration 0014 already created a durable
 * `idempotency_keys` table with a UNIQUE(tenant_id, method, path,
 * idempotency_key) constraint specifically for this fallback role — but
 * no code ever read or wrote it (confirmed by grep: the migration file
 * was the only match in the whole backend). This fix wires that table
 * up as the actual fallback, replacing the per-process Map, so the
 * claim is atomic and durable across every replica, not just within
 * one process's memory.
 *
 * Key format: `idempotency:<tenantId>:<method>:<path>:<key>` to avoid cross-tenant
 * collisions and allow scoped replay when the same key is intentionally used
 * across different endpoints.
 */

export const IDEMPOTENCY_TTL_SECONDS = 300; // 5 minutes
const IDEMPOTENCY_HEADER = "idempotency-key";

interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
}

function buildKey(tenantId: string, method: string, path: string, key: string): string {
  return `idempotency:${tenantId}:${method}:${path}:${key}`;
}

export function getIdempotencyKey(req: {
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 200) return null;
  return trimmed;
}

export async function readCached(
  tenantId: string,
  method: string,
  path: string,
  key: string,
): Promise<CachedResponse | null> {
  const fullKey = buildKey(tenantId, method, path, key);
  if (redis) {
    try {
      const raw = await redis.get(fullKey);
      if (raw) return JSON.parse(raw) as CachedResponse;
    } catch {
      // fall through to the durable DB store
    }
  }
  const { rows } = await pool.query(
    `SELECT status_code, response_body, content_type
       FROM idempotency_keys
      WHERE tenant_id = $1 AND method = $2 AND path = $3 AND idempotency_key = $4
        AND status_code > 0 AND expires_at > now()`,
    [tenantId, method, path, key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status_code,
    body: typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body,
    contentType: row.content_type,
  };
}

export async function writeCached(
  tenantId: string,
  method: string,
  path: string,
  key: string,
  status: number,
  body: string,
  contentType: string,
): Promise<void> {
  const fullKey = buildKey(tenantId, method, path, key);
  const value: CachedResponse = { status, body, contentType };
  if (redis) {
    try {
      await redis.setex(fullKey, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(value));
      return;
    } catch {
      // fall through to the durable DB store
    }
  }
  await pool.query(
    `UPDATE idempotency_keys
        SET status_code = $5, response_body = $6::jsonb, content_type = $7
      WHERE tenant_id = $1 AND method = $2 AND path = $3 AND idempotency_key = $4`,
    [tenantId, method, path, key, status, JSON.stringify(body), contentType],
  );
}

/**
 * Atomically claim an idempotency key BEFORE running the handler (I3 fix).
 * Under concurrency, two in-flight requests with the same key must not both
 * execute: the first caller wins the claim; the second is a duplicate.
 * - Redis: `SET key value NX EX ttl` (returns "OK" only if the key is new).
 * - DB fallback (fix C-6): `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *   <existing row already expired>` against the UNIQUE(tenant_id, method,
 *   path, idempotency_key) constraint from migration 0014. This is atomic
 *   at the database level (a single statement, real row lock during the
 *   upsert) and durable across every replica and process restart — unlike
 *   the in-memory Map it replaces, which was neither.
 */
export async function tryClaim(
  tenantId: string,
  method: string,
  path: string,
  key: string,
): Promise<boolean> {
  const fullKey = buildKey(tenantId, method, path, key);
  if (redis) {
    try {
      const placeholder: CachedResponse = { status: 0, body: "", contentType: "application/json" };
      const result = await redis.set(
        fullKey,
        JSON.stringify(placeholder),
        "EX",
        IDEMPOTENCY_TTL_SECONDS,
        "NX",
      );
      return result === "OK";
    } catch {
      // fall through to the durable DB store
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO idempotency_keys (tenant_id, method, path, idempotency_key, status_code, expires_at)
     VALUES ($1, $2, $3, $4, 0, now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds')
     ON CONFLICT (tenant_id, method, path, idempotency_key)
     DO UPDATE SET status_code = 0, response_body = NULL,
                   expires_at = now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds'
     WHERE idempotency_keys.expires_at < now()
     RETURNING id`,
    [tenantId, method, path, key],
  );
  return rows.length > 0;
}

export { redis };
