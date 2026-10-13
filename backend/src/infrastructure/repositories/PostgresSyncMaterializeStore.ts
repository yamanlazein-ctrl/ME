/** PostgreSQL SQL for sync materialization — moved verbatim from syncMaterialize.ts (S1). */
/** The shared pool from drizzle.ts (structural type: only drizzle.ts may import pg — rls-guard). */
type QueryPool = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
};
import { sql, type SQL } from "drizzle-orm";
import type {
  ISyncMaterializeStore,
  SyncUserSnapshotRow,
} from "../../application/ports/ISyncMaterializeStore.js";

export class PostgresSyncMaterializeStore implements ISyncMaterializeStore {
  /**
   * `ambient` is drizzle.ts's `txDb`: it joins the caller's `withTenantTx` when one is active.
   * S-02: the tombstone MUST commit with the delete it records (F-03) — on the raw pool it
   * committed on its own connection, so a failure after it left a deleted row's state split.
   */
  constructor(
    private readonly pool: QueryPool,
    private readonly ambient: { execute: (query: SQL) => Promise<unknown> },
  ) {}

  async tombstoneExists(tenantId: string, entityType: string, entityId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM sync_tombstones
        WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
        LIMIT 1`,
      [tenantId, entityType, entityId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recordTombstone(
    tenantId: string,
    entityType: string,
    entityId: string,
    opId: string,
    deletedByDeviceId: string | null,
  ): Promise<void> {
    await this.ambient.execute(sql`
      INSERT INTO sync_tombstones
          (id, tenant_id, entity_type, entity_id, op_id, deleted_by_device_id, deletion_seq)
        SELECT gen_random_uuid(), ${tenantId}, ${entityType}, ${entityId}, ${opId}, ${deletedByDeviceId},
               COALESCE(MAX(deletion_seq), 0) + 1
          FROM sync_tombstones
         WHERE tenant_id = ${tenantId}
       ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`);
  }

  async findUserRole(tenantId: string, userId: string): Promise<string | null> {
    const r = await this.pool.query(
      `SELECT role FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, userId],
    );
    return (r.rows[0] as { role?: string } | undefined)?.role ?? null;
  }

  async upsertUserSnapshot(u: SyncUserSnapshotRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, pin_hash, role, active, updated_at, tokens_revoked_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz, CASE WHEN $8 = false THEN now() ELSE NULL END)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         pin_hash = EXCLUDED.pin_hash,
         role = EXCLUDED.role,
         active = EXCLUDED.active,
         tokens_revoked_before = CASE WHEN EXCLUDED.active = false THEN now() ELSE users.tokens_revoked_before END,
         updated_at = EXCLUDED.updated_at
       WHERE users.tenant_id = EXCLUDED.tenant_id
         AND users.updated_at <= EXCLUDED.updated_at`,
      [u.id, u.tenantId, u.name, u.email, u.passwordHash, u.pinHash, u.role, u.active, u.updatedAt],
    );
  }
}
