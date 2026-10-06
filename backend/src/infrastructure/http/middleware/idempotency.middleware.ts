import { Redis } from "ioredis";
import { redis } from "../../auth/TokenDenylist.js";
import { getEngine } from "../../orm/engine.js";
import { pgPool } from "../../orm/pgLazy.js";

/**
 * Durable store: the PostgreSQL pool (cloud, unchanged) or the SQLite engine (desktop,
 * specs/001-desktop-sqlite-engine). The SQLite branch runs the same statements in SQLite syntax;
 * its writes are autonomous like pool.query (they survive a caller's rollback), TTLs come from the
 * µs clock, and jsonb bodies keep jsonb key order — so a cached replay is byte-identical.
 */
type Rows = { rows: Array<Record<string, any>> };
const isSqlite = () => getEngine() === "sqlite";
async function q(pgText: string, sqliteText: string, params: unknown[], write = false): Promise<Rows> {
  if (!isSqlite()) return (await pgPool()).query(pgText, params) as unknown as Rows;
  const [{ sql }, { sqliteDb, runAutonomous }] = await Promise.all([
    import("drizzle-orm"),
    import("../../orm/sqlite/transaction.js"),
  ]);
  const parts = sqliteText.split("?");
  const chunks = parts.map((part, i) => (i < params.length ? sql`${sql.raw(part)}${params[i]}` : sql.raw(part)));
  const stmt = sql.join(chunks, sql``);
  if (!write) return (await sqliteDb().execute(stmt)) as Rows;
  return runAutonomous(async (tx) => (await tx.execute(stmt)) as Rows);
}
async function sqliteNowPlus(seconds: number): Promise<{ now: string; until: string }> {
  const { transactionTimestamp, formatMicrosUtc, parseMicrosUtc } = await import("../../orm/sqlite/clock.js");
  const now = transactionTimestamp();
  return { now, until: formatMicrosUtc(parseMicrosUtc(now) + BigInt(seconds) * 1_000_000n) };
}
async function jsonbText(v: unknown): Promise<string> {
  return (await import("../../orm/sqlite/types.js")).toJsonbText(v);
}
/** node-pg parses jsonb; SQLite returns the stored text. */
function parsedBody<T extends Record<string, any> | undefined>(row: T): T {
  return row && isSqlite() && typeof row.response_body === "string"
    ? ({ ...row, response_body: JSON.parse(row.response_body) } as T)
    : row;
}

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
 *
 * Scope boundary (P3-2): this is an HTTP retry guard only. It expires after five
 * minutes and never deduplicates sync operations. Sync durability is provided by
 * the `(tenant_id, op_id)` uniqueness constraints on sync inbox/outbox; callers
 * must retain the same op_id when replaying a sync unit.
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
  const nowText = isSqlite() ? (await sqliteNowPlus(0)).now : null;
  const { rows } = await q(
    `SELECT status_code, response_body, content_type
       FROM idempotency_keys
      WHERE tenant_id = $1 AND method = $2 AND path = $3 AND idempotency_key = $4
        AND status_code > 0 AND expires_at > now()`,
    `SELECT status_code, response_body, content_type
       FROM idempotency_keys
      WHERE tenant_id = ? AND method = ? AND path = ? AND idempotency_key = ?
        AND status_code > 0 AND expires_at > ?`,
    isSqlite() ? [tenantId, method, path, key, nowText] : [tenantId, method, path, key],
  );
  const row = parsedBody(rows[0]);
  if (row) {
    return {
      status: row.status_code,
      body: typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body,
      contentType: row.content_type,
    };
  }
  // OLD-PLAN Phase 1: durable financial_operations — survives beyond 5-minute TTL.
  try {
    const durable = await q(
      `SELECT status_code, response_body, content_type
         FROM financial_operations
        WHERE tenant_id = $1 AND method = $2 AND path = $3 AND operation_key = $4
          AND status_code > 0`,
      `SELECT status_code, response_body, content_type
         FROM financial_operations
        WHERE tenant_id = ? AND method = ? AND path = ? AND operation_key = ?
          AND status_code > 0`,
      [tenantId, method, path, key],
    );
    const d = parsedBody(durable.rows[0]);
    if (!d) return null;
    return {
      status: d.status_code,
      body: typeof d.response_body === "string" ? d.response_body : JSON.stringify(d.response_body),
      contentType: d.content_type,
    };
  } catch {
    return null;
  }
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
    } catch {
      // fall through to the durable DB store
    }
  }
  await q(
    `UPDATE idempotency_keys
        SET status_code = $5, response_body = $6::jsonb, content_type = $7
      WHERE tenant_id = $1 AND method = $2 AND path = $3 AND idempotency_key = $4`,
    `UPDATE idempotency_keys
        SET status_code = ?, response_body = ?, content_type = ?
      WHERE tenant_id = ? AND method = ? AND path = ? AND idempotency_key = ?`,
    isSqlite()
      ? [status, await jsonbText(body), contentType, tenantId, method, path, key]
      : [tenantId, method, path, key, status, JSON.stringify(body), contentType],
    true,
  );
  // Persist permanently for financial retries after TTL (table may be absent on old DBs).
  try {
    const nowText = isSqlite() ? (await sqliteNowPlus(0)).now : null;
    await q(
      `INSERT INTO financial_operations (tenant_id, method, path, operation_key, status_code, response_body, content_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (tenant_id, method, path, operation_key)
       DO UPDATE SET status_code = EXCLUDED.status_code,
                     response_body = EXCLUDED.response_body,
                     content_type = EXCLUDED.content_type,
                     updated_at = now()`,
      `INSERT INTO financial_operations (tenant_id, method, path, operation_key, status_code, response_body, content_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, method, path, operation_key)
       DO UPDATE SET status_code = excluded.status_code,
                     response_body = excluded.response_body,
                     content_type = excluded.content_type,
                     updated_at = excluded.updated_at`,
      isSqlite()
        ? [tenantId, method, path, key, status, await jsonbText(JSON.parse(body)), contentType, nowText, nowText]
        : [tenantId, method, path, key, status, body, contentType],
      true,
    );
  } catch {
    /* migration not applied yet — short TTL path still works */
  }
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
  // If a durable financial result already exists, never re-execute.
  try {
    const { rows: durable } = await q(
      `SELECT 1 FROM financial_operations
        WHERE tenant_id = $1 AND method = $2 AND path = $3 AND operation_key = $4
          AND status_code > 0
        LIMIT 1`,
      `SELECT 1 FROM financial_operations
        WHERE tenant_id = ? AND method = ? AND path = ? AND operation_key = ?
          AND status_code > 0
        LIMIT 1`,
      [tenantId, method, path, key],
    );
    if (durable.length > 0) return false;
  } catch {
    /* table may not exist yet */
  }

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
  const t = isSqlite() ? await sqliteNowPlus(IDEMPOTENCY_TTL_SECONDS) : null;
  const { rows } = await q(
    `INSERT INTO idempotency_keys (tenant_id, method, path, idempotency_key, status_code, expires_at)
     VALUES ($1, $2, $3, $4, 0, now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds')
     ON CONFLICT (tenant_id, method, path, idempotency_key)
     DO UPDATE SET status_code = 0, response_body = NULL,
                   expires_at = now() + interval '${IDEMPOTENCY_TTL_SECONDS} seconds'
     WHERE idempotency_keys.expires_at < now()
     RETURNING id`,
    `INSERT INTO idempotency_keys (tenant_id, method, path, idempotency_key, status_code, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (tenant_id, method, path, idempotency_key)
     DO UPDATE SET status_code = 0, response_body = NULL, expires_at = excluded.expires_at
     WHERE idempotency_keys.expires_at < ?
     RETURNING id`,
    isSqlite() ? [tenantId, method, path, key, t!.until, t!.now, t!.now] : [tenantId, method, path, key],
    true,
  );
  return rows.length > 0;
}

export { redis };
