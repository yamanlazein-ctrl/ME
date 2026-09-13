import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  EnqueueSyncOutboxInput,
  ISyncOutboxRepository,
  SyncOutboxRow,
  SyncOutboxStatus,
} from "../../application/ports/ISyncOutboxRepository.js";
import { syncOutbox } from "../orm/schemas/sync-outbox.table.js";

/**
 * How long a `pushing` row is trusted to still be in flight before another run
 * may reclaim it. Must exceed the push timeout in `runLocalSyncPush`
 * (15s per unit, up to 50 units per batch) so a healthy in-flight batch is
 * never stolen — 5 minutes leaves ample headroom.
 */
export const DEFAULT_PUSHING_LEASE_MS = 5 * 60 * 1000;

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
    seq: Number(row.seq),
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

  /**
   * Ordering is by `seq` (monotonic insert order), never by `created_at`:
   * `created_at` defaults to now() = transaction-start time, so units enqueued
   * in one transaction share a timestamp and their relative order would be
   * arbitrary — and could differ between two runs of the same backlog.
   */
  async listClaimable(
    tenantId: string,
    limit = 50,
    stalePushingMs = DEFAULT_PUSHING_LEASE_MS,
  ): Promise<SyncOutboxRow[]> {
    const leaseCutoff = new Date(Date.now() - stalePushingMs);
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.tenantId, tenantId),
            or(
              eq(syncOutbox.status, "pending"),
              // A unit abandoned mid-push by a dead process becomes claimable
              // again once its lease expires. Without this it is lost forever.
              and(eq(syncOutbox.status, "pushing"), lt(syncOutbox.updatedAt, leaseCutoff)),
            ),
          ),
        )
        .orderBy(asc(syncOutbox.seq))
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

  async countOutstanding(tenantId: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(syncOutbox)
        .where(
          and(
            eq(syncOutbox.tenantId, tenantId),
            inArray(syncOutbox.status, ["pending", "pushing"]),
          ),
        );
      return Number(row?.c ?? 0);
    });
  }

  async countByStatus(tenantId: string): Promise<Record<SyncOutboxStatus, number>> {
    const empty: Record<SyncOutboxStatus, number> = {
      pending: 0,
      pushing: 0,
      synced: 0,
      rejected: 0,
    };
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select({ status: syncOutbox.status, c: sql<number>`count(*)::int` })
        .from(syncOutbox)
        .where(eq(syncOutbox.tenantId, tenantId))
        .groupBy(syncOutbox.status);
      for (const r of rows) {
        const key = r.status as SyncOutboxStatus;
        if (key in empty) empty[key] = Number(r.c);
      }
      return empty;
    });
  }
}
