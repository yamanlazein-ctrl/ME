import { pool } from "../../../infrastructure/orm/drizzle.js";
import { logger } from "../../../infrastructure/config/logger.js";

/**
 * Conflict tracking for concurrent document updates/cancels (plan §4, §11;
 * migration 20260912_batch1_tombstones_conflicts.sql `sync_conflicts`).
 *
 * Two devices that edit/cancel the same document from the same base version
 * cannot both win. This module is the durable, queryable RECORD of that
 * conflict — who lost (op_id), on what document, with which base version they
 * started and which server version actually won, plus their full local intent.
 * Resolution is ALWAYS explicit (a `resolveSyncConflict` decision by an
 * operator/user) — never a blind last-write-wins auto-merge on a financial
 * document.
 *
 * The row is written idempotently per (tenant_id, op_id): the first conflict
 * sighting wins and retries are no-ops. It is marked `resolved` when the
 * losing unit is later applied (it converged) or when an operator records an
 * explicit resolution decision.
 */

export type SyncConflictOperation = "update" | "cancel";

export type SyncConflictResolutionDecision =
  | "keep-server" // explicit: hub state wins, local intent discarded (not silent)
  | "rebase" //      explicit: local intent to be re-submitted as a NEW edit vs the current server version
  | "withdraw"; //   explicit: the update/cancel intent is dropped

export type RecordSyncConflictInput = {
  tenantId: string;
  opId: string;
  entityType: string;
  entityId: string;
  operation: SyncConflictOperation;
  baseVersion: number | null;
  serverVersion: number | null;
  localIntent: Record<string, unknown>;
};

export type SyncConflictRow = {
  id: string;
  opId: string;
  entityType: string;
  entityId: string;
  operation: SyncConflictOperation;
  baseVersion: number | null;
  serverVersion: number | null;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
  resolution: Record<string, unknown> | null;
};

function mapConflict(r: Record<string, unknown>): SyncConflictRow {
  return {
    id: String(r.id),
    opId: String(r.op_id),
    entityType: String(r.entity_type),
    entityId: String(r.entity_id),
    operation: String(r.operation) as SyncConflictOperation,
    baseVersion: r.base_version == null ? null : Number(r.base_version),
    serverVersion: r.server_version == null ? null : Number(r.server_version),
    status: String(r.status) as SyncConflictRow["status"],
    createdAt: (r.created_at as Date).toISOString(),
    resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
    resolution: r.resolution ? (r.resolution as Record<string, unknown>) : null,
  };
}

/**
 * Record an update/cancel conflict. Idempotent: the FIRST sighting of an
 * op_id wins, later retries/duplicate deliveries are no-ops.
 * Returns true if a new row was written.
 */
export async function recordSyncConflict(input: RecordSyncConflictInput): Promise<boolean> {
  try {
    const r = await pool.query(
      `INSERT INTO sync_conflicts
         (id, tenant_id, op_id, entity_type, entity_id, operation,
          base_version, server_version, local_intent, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'open')
       ON CONFLICT (tenant_id, op_id) DO NOTHING`,
      [
        input.tenantId,
        input.opId,
        input.entityType,
        input.entityId,
        input.operation,
        input.baseVersion,
        input.serverVersion,
        JSON.stringify(input.localIntent),
      ],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn(
      { err, opId: input.opId, entityType: input.entityType, entityId: input.entityId },
      "recordSyncConflict failed (best-effort)",
    );
    return false;
  }
}

/**
 * List conflicts for a tenant. Defaults to `open` (unresolved) so an operator
 * sees exactly what still needs a decision.
 */
export async function listSyncConflicts(
  tenantId: string,
  opts?: { openOnly?: boolean; limit?: number },
): Promise<SyncConflictRow[]> {
  const openOnly = opts?.openOnly ?? true;
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 1000);
  try {
    const r = await pool.query(
      `SELECT id, op_id, entity_type, entity_id, operation, base_version,
              server_version, status, created_at, resolved_at, resolution
         FROM sync_conflicts
        WHERE tenant_id = $1 ${openOnly ? "AND status = 'open'" : ""}
        ORDER BY created_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return (r.rows ?? []).map((row) => mapConflict(row));
  } catch (err) {
    logger.warn({ err }, "listSyncConflicts failed");
    return [];
  }
}

/**
 * Resolve one open conflict explicitly. No blind overwrite: the losing local
 * intent is never auto-applied here — an operator records the decision, and
 * for `rebase` the returned row's `serverVersion` is the version a legit
 * re-submission must be based on (the caller turns local intent into a NEW
 * edit against that version). Returns the updated row, or null if the conflict
 * was not open (already resolved / not found).
 */
export async function resolveSyncConflict(
  tenantId: string,
  conflictId: string,
  decision: SyncConflictResolutionDecision,
  byUserId: string | null,
  note?: string,
): Promise<SyncConflictRow | null> {
  try {
    const r = await pool.query(
      `UPDATE sync_conflicts
          SET status = 'resolved',
              resolved_at = now(),
              resolution = jsonb_build_object(
                'decision', $3,
                'by_user_id', $4,
                'note', $5,
                'resolved_at', now()
              )
        WHERE id = $2 AND tenant_id = $1 AND status = 'open'
        RETURNING id, op_id, entity_type, entity_id, operation, base_version,
                  server_version, status, created_at, resolved_at, resolution`,
      [tenantId, conflictId, decision, byUserId, note ?? null],
    );
    return r.rowCount ? mapConflict(r.rows[0]) : null;
  } catch (err) {
    logger.warn({ err, conflictId }, "resolveSyncConflict failed");
    return null;
  }
}

/**
 * Mark an open conflict resolved because the losing unit actually APPLIED
 * (it converged on a later retry) — the record must not sit open forever when
 * the underlying operation succeeded. No-op when no open row exists.
 */
export async function resolveSyncConflictByOp(
  tenantId: string,
  opId: string,
  reason: string,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE sync_conflicts
          SET status = 'resolved',
              resolved_at = now(),
              resolution = jsonb_build_object('decision', 'applied', 'note', $3, 'resolved_at', now())
        WHERE tenant_id = $1 AND op_id = $2 AND status = 'open'`,
      [tenantId, opId, reason],
    );
  } catch (err) {
    logger.warn({ err, opId }, "resolveSyncConflictByOp failed");
  }
}