/** PostgreSQL `sync_conflicts` SQL — moved verbatim from syncConflicts.ts (S1). */
/** The shared pool from drizzle.ts (structural type: only drizzle.ts may import pg — rls-guard). */
type QueryPool = { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }> };
import type { ISyncConflictStore, SyncConflictDbRow } from "../../application/ports/ISyncConflictStore.js";

export class PostgresSyncConflictStore implements ISyncConflictStore {
  constructor(private readonly pool: QueryPool) {}

  async insertOpen(input: Parameters<ISyncConflictStore["insertOpen"]>[0]): Promise<number> {
    const r = await this.pool.query(
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
        input.localIntentJson,
      ],
    );
    return r.rowCount ?? 0;
  }

  async list(tenantId: string, openOnly: boolean, limit: number): Promise<SyncConflictDbRow[]> {
    const r = await this.pool.query(
      `SELECT id, op_id, entity_type, entity_id, operation, base_version,
              server_version, status, created_at, resolved_at, resolution, local_intent
         FROM sync_conflicts
        WHERE tenant_id = $1 ${openOnly ? "AND status = 'open'" : ""}
        ORDER BY created_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows ?? [];
  }

  async resolve(
    tenantId: string,
    conflictId: string,
    decision: string,
    byUserId: string | null,
    note: string | null,
  ): Promise<SyncConflictDbRow | null> {
    const r = await this.pool.query(
      `UPDATE sync_conflicts
          SET status = 'resolved',
              resolved_at = now(),
              resolution = jsonb_build_object(
                'decision', $3::text,
                'by_user_id', $4::text,
                'note', $5::text,
                'resolved_at', now()
              )
        WHERE id = $2 AND tenant_id = $1 AND status = 'open'
        RETURNING id, op_id, entity_type, entity_id, operation, base_version,
                  server_version, status, created_at, resolved_at, resolution, local_intent`,
      [tenantId, conflictId, decision, byUserId, note],
    );
    return r.rowCount ? r.rows[0] : null;
  }

  async resolveByOp(tenantId: string, opId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE sync_conflicts
          SET status = 'resolved',
              resolved_at = now(),
              resolution = jsonb_build_object('decision', 'applied', 'note', $3::text, 'resolved_at', now())
        WHERE tenant_id = $1 AND op_id = $2 AND status = 'open'`,
      [tenantId, opId, reason],
    );
  }
}
