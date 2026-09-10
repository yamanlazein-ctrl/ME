import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  EnqueueSyncOutboxInput,
  ISyncOutboxRepository,
  SyncOutboxRow,
} from "../../application/ports/ISyncOutboxRepository.js";
import { syncOutbox } from "../orm/schemas/sync-outbox.table.js";

function mapRow(row: typeof syncOutbox.$inferSelect): SyncOutboxRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    syncDeviceId: row.syncDeviceId,
    opId: row.opId,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as SyncOutboxRow["status"],
    errorDetail: row.errorDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt,
  };
}

export class PostgresSyncOutboxRepository implements ISyncOutboxRepository {
  constructor(private readonly db: DB) {}

  async enqueue(input: EnqueueSyncOutboxInput): Promise<SyncOutboxRow> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const existing = await this.db
        .select()
        .from(syncOutbox)
        .where(and(eq(syncOutbox.tenantId, input.tenantId), eq(syncOutbox.opId, input.opId)))
        .limit(1);
      if (existing[0]) return mapRow(existing[0]);

      const [row] = await this.db
        .insert(syncOutbox)
        .values({
          tenantId: input.tenantId,
          syncDeviceId: input.syncDeviceId ?? null,
          opId: input.opId,
          entityType: input.entityType,
          entityId: input.entityId,
          operation: input.operation,
          payload: input.payload,
          status: "pending",
        })
        .returning();
      return mapRow(row);
    });
  }

  async listPending(tenantId: string, limit = 50): Promise<SyncOutboxRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncOutbox)
        .where(and(eq(syncOutbox.tenantId, tenantId), eq(syncOutbox.status, "pending")))
        .orderBy(asc(syncOutbox.createdAt))
        .limit(limit);
      return rows.map(mapRow);
    });
  }

  async markPushing(ids: string[], tenantId: string): Promise<void> {
    if (ids.length === 0) return;
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .update(syncOutbox)
        .set({ status: "pushing", updatedAt: new Date() })
        .where(and(eq(syncOutbox.tenantId, tenantId), inArray(syncOutbox.id, ids)));
    });
  }

  async markSynced(id: string, tenantId: string): Promise<void> {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .update(syncOutbox)
        .set({ status: "synced", syncedAt: new Date(), updatedAt: new Date(), errorDetail: null })
        .where(and(eq(syncOutbox.id, id), eq(syncOutbox.tenantId, tenantId)));
    });
  }

  async markRejected(id: string, tenantId: string, errorDetail: string): Promise<void> {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .update(syncOutbox)
        .set({ status: "rejected", errorDetail, updatedAt: new Date() })
        .where(and(eq(syncOutbox.id, id), eq(syncOutbox.tenantId, tenantId)));
    });
  }

  async resetToPending(id: string, tenantId: string, errorDetail?: string): Promise<void> {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .update(syncOutbox)
        .set({
          status: "pending",
          errorDetail: errorDetail ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(syncOutbox.id, id), eq(syncOutbox.tenantId, tenantId)));
    });
  }

  async countPending(tenantId: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(syncOutbox)
        .where(and(eq(syncOutbox.tenantId, tenantId), eq(syncOutbox.status, "pending")));
      return Number(row?.c ?? 0);
    });
  }
}
