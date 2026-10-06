// PORTED-FROM: src/infrastructure/repositories/PostgresSyncMaterializeStore.ts sha256=fb1d875a388c2e2deece37a390e92626a67fe2957109f09764bf4eeb40ab0b36
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
/**
 * Sync materialization writes on SQLite (tombstones, user snapshots).
 *
 * PG runs them on the shared pool, committing independently of the caller's transaction
 * (research I-2); here they go through `runAutonomous`. `now()` of that autonomous statement is
 * the transaction clock; bound timestamps keep microseconds (`$n::timestamptz` → toTimestamptzText).
 */
import { sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { runAutonomous } from "../../orm/sqlite/transaction.js";
import { transactionTimestamp } from "../../orm/sqlite/clock.js";
import { randomUuid, toTimestamptzText } from "../../orm/sqlite/types.js";
import type { ISyncMaterializeStore, SyncUserSnapshotRow } from "../../../application/ports/ISyncMaterializeStore.js";

export class SqliteSyncMaterializeStore implements ISyncMaterializeStore {
  constructor(private readonly db: DB) {}

  async tombstoneExists(tenantId: string, entityType: string, entityId: string): Promise<boolean> {
    const r = await this.db.execute(sql`
      SELECT 1 FROM sync_tombstones
       WHERE tenant_id = ${tenantId} AND entity_type = ${entityType} AND entity_id = ${entityId}
       LIMIT 1`);
    return r.rowCount > 0;
  }

  async recordTombstone(
    tenantId: string,
    entityType: string,
    entityId: string,
    opId: string,
    deletedByDeviceId: string | null,
  ): Promise<void> {
    await runAutonomous(async (tx) => {
      await tx.execute(sql`
        INSERT INTO sync_tombstones
            (id, tenant_id, entity_type, entity_id, op_id, deleted_by_device_id, deletion_seq, created_at)
          SELECT ${randomUuid()}, ${tenantId}, ${entityType}, ${entityId}, ${opId}, ${deletedByDeviceId},
                 COALESCE(MAX(deletion_seq), 0) + 1, ${transactionTimestamp()}
            FROM sync_tombstones
           WHERE tenant_id = ${tenantId}
         ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`);
    });
  }

  async upsertUserSnapshot(u: SyncUserSnapshotRow): Promise<void> {
    await runAutonomous(async (tx) => {
      const now = transactionTimestamp();
      const active = u.active ? 1 : 0;
      await tx.execute(sql`
        INSERT INTO users (id, tenant_id, name, email, password_hash, pin_hash, role, active, updated_at, tokens_revoked_before)
        VALUES (${u.id}, ${u.tenantId}, ${u.name}, ${u.email}, ${u.passwordHash}, ${u.pinHash}, ${u.role}, ${active},
                ${toTimestamptzText(u.updatedAt)}, CASE WHEN ${active} = 0 THEN ${now} ELSE NULL END)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          email = excluded.email,
          password_hash = excluded.password_hash,
          pin_hash = excluded.pin_hash,
          role = excluded.role,
          active = excluded.active,
          tokens_revoked_before = CASE WHEN excluded.active = 0 THEN ${now} ELSE users.tokens_revoked_before END,
          updated_at = excluded.updated_at
        WHERE users.tenant_id = excluded.tenant_id
          AND users.updated_at <= excluded.updated_at`);
    });
  }
}
