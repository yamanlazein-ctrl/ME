// PORTED-FROM: src/infrastructure/repositories/PostgresSyncConflictStore.ts sha256=71637d357960b539b7a685993b7d3d25aaa644a795f93f8a3546829bd6551aae
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
/**
 * `sync_conflicts` on SQLite.
 *
 * PG runs these on the shared pool (research I-2): each write commits on its own connection, even
 * when the caller is inside a transaction that later rolls back. Here every write goes through
 * `runAutonomous` (joins the caller, replayed after a rollback) for the same durable effect. Rows
 * come back in node-pg's raw shapes: timestamptz → Date, jsonb → parsed object.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { runAutonomous } from "../../orm/sqlite/transaction.js";
import { transactionTimestamp } from "../../orm/sqlite/clock.js";
import { pgJsonTimestamptz, randomUuid, toJsonbText } from "../../orm/sqlite/types.js";
import type { ISyncConflictStore, SyncConflictDbRow } from "../../../application/ports/ISyncConflictStore.js";

const COLUMNS = sql.raw(`id, op_id, entity_type, entity_id, operation, base_version,
              server_version, status, created_at, resolved_at, resolution, local_intent`);

/** node-pg's default parsers: timestamptz → Date, jsonb → object. */
function pgRow(r: Record<string, unknown>): SyncConflictDbRow {
  return {
    ...r,
    created_at: r.created_at == null ? null : new Date(String(r.created_at)),
    resolved_at: r.resolved_at == null ? null : new Date(String(r.resolved_at)),
    resolution: r.resolution == null ? null : JSON.parse(String(r.resolution)),
    local_intent: r.local_intent == null ? null : JSON.parse(String(r.local_intent)),
  } as unknown as SyncConflictDbRow;
}

export class SqliteSyncConflictStore implements ISyncConflictStore {
  constructor(private readonly db: DB) {}

  async insertOpen(input: Parameters<ISyncConflictStore["insertOpen"]>[0]): Promise<number> {
    return runAutonomous(async (tx) => {
      const r = await tx.execute(sql`
        INSERT INTO sync_conflicts
           (id, tenant_id, op_id, entity_type, entity_id, operation,
            base_version, server_version, local_intent, status, created_at)
        VALUES (${randomUuid()}, ${input.tenantId}, ${input.opId}, ${input.entityType}, ${input.entityId},
                ${input.operation}, ${input.baseVersion}, ${input.serverVersion},
                ${input.localIntentJson == null ? null : toJsonbText(JSON.parse(String(input.localIntentJson)))},
                'open', ${transactionTimestamp()})
        ON CONFLICT (tenant_id, op_id) DO NOTHING`);
      return r.rowCount;
    });
  }

  async list(tenantId: string, openOnly: boolean, limit: number): Promise<SyncConflictDbRow[]> {
    const r = await this.db.execute(sql`
      SELECT ${COLUMNS}
        FROM sync_conflicts
       WHERE tenant_id = ${tenantId} ${openOnly ? sql`AND status = 'open'` : sql``}
       ORDER BY created_at DESC
       LIMIT ${limit}`);
    return r.rows.map(pgRow);
  }

  async resolve(
    tenantId: string,
    conflictId: string,
    decision: string,
    byUserId: string | null,
    note: string | null,
  ): Promise<SyncConflictDbRow | null> {
    return runAutonomous(async (tx) => {
      const now = transactionTimestamp();
      // jsonb_build_object(...) — same keys and values; toJsonbText applies jsonb key order.
      const resolution = toJsonbText({ decision, by_user_id: byUserId, note, resolved_at: pgJsonTimestamptz(now) });
      const updated = await tx.execute(sql`
        UPDATE sync_conflicts
           SET status = 'resolved', resolved_at = ${now}, resolution = ${resolution}
         WHERE id = ${conflictId} AND tenant_id = ${tenantId} AND status = 'open'`);
      if (!updated.rowCount) return null;
      const r = await tx.execute(sql`SELECT ${COLUMNS} FROM sync_conflicts WHERE id = ${conflictId} AND tenant_id = ${tenantId}`);
      return r.rows[0] ? pgRow(r.rows[0]) : null;
    });
  }

  async resolveByOp(tenantId: string, opId: string, reason: string): Promise<void> {
    await runAutonomous(async (tx) => {
      const now = transactionTimestamp();
      const resolution = toJsonbText({ decision: "applied", note: reason, resolved_at: pgJsonTimestamptz(now) });
      await tx.execute(sql`
        UPDATE sync_conflicts
           SET status = 'resolved', resolved_at = ${now}, resolution = ${resolution}
         WHERE tenant_id = ${tenantId} AND op_id = ${opId} AND status = 'open'`);
    });
  }
}
