import { and, asc, eq, gt } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  ISyncInboxRepository,
  ReceiveSyncUnitInput,
  SyncInboxRow,
} from "../../application/ports/ISyncInboxRepository.js";
import { syncInbox } from "../orm/schemas/sync-inbox.table.js";

function mapRow(row: typeof syncInbox.$inferSelect): SyncInboxRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    syncDeviceId: row.syncDeviceId,
    opId: row.opId,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as SyncInboxRow["status"],
    rejectReason: row.rejectReason ?? null,
    conflictOpId: row.conflictOpId ?? null,
    conflictDetail: (row.conflictDetail as Record<string, unknown> | null) ?? null,
    receivedAt: row.receivedAt,
    appliedAt: row.appliedAt,
  };
}

export class PostgresSyncInboxRepository implements ISyncInboxRepository {
  constructor(private readonly db: DB) {}

  async receive(input: ReceiveSyncUnitInput) {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const existing = await this.db
        .select()
        .from(syncInbox)
        .where(and(eq(syncInbox.tenantId, input.tenantId), eq(syncInbox.opId, input.opId)))
        .limit(1);
      if (existing[0]) return { row: mapRow(existing[0]), created: false };

      const [row] = await this.db
        .insert(syncInbox)
        .values({
          tenantId: input.tenantId,
          syncDeviceId: input.syncDeviceId ?? null,
          opId: input.opId,
          entityType: input.entityType,
          entityId: input.entityId,
          operation: input.operation,
          payload: input.payload,
          status: input.status ?? "received",
          rejectReason: input.rejectReason ?? null,
          conflictOpId: input.conflictOpId ?? null,
          conflictDetail: input.conflictDetail ?? null,
        })
        .returning();
      return { row: mapRow(row), created: true };
    });
  }

  async markRejected(
    tenantId: string,
    opId: string,
    reason: string,
    conflictOpId?: string | null,
    conflictDetail?: Record<string, unknown> | null,
  ) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncInbox)
        .set({
          status: "rejected",
          rejectReason: reason,
          conflictOpId: conflictOpId ?? null,
          conflictDetail: conflictDetail ?? null,
        })
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .returning();
      return row ? mapRow(row) : null;
    });
  }

  async markApplied(tenantId: string, opId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncInbox)
        .set({ status: "applied", appliedAt: new Date() })
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .returning();
      return row ? mapRow(row) : null;
    });
  }

  async findByOpId(tenantId: string, opId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select()
        .from(syncInbox)
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .limit(1);
      return row ? mapRow(row) : null;
    });
  }

  async listAppliedSince(
    tenantId: string,
    after: Date | null,
    opts?: { excludeSyncDeviceId?: string | null; limit?: number },
  ) {
    return runWithTenantContext({ tenantId }, async () => {
      const limit = opts?.limit ?? 50;
      const conditions = [
        eq(syncInbox.tenantId, tenantId),
        eq(syncInbox.status, "applied"),
      ];
      if (after) {
        conditions.push(gt(syncInbox.receivedAt, after));
      }

      const rows = await this.db
        .select()
        .from(syncInbox)
        .where(and(...conditions))
        .orderBy(asc(syncInbox.receivedAt))
        .limit(Math.min(Math.max(limit, 1), 100) * 2);

      let filtered = rows.map(mapRow);
      if (opts?.excludeSyncDeviceId) {
        filtered = filtered.filter((r) => r.syncDeviceId !== opts.excludeSyncDeviceId);
      }
      return filtered.slice(0, Math.min(Math.max(limit, 1), 100));
    });
  }

  async setMaterializeError(tenantId: string, opId: string, detail: Record<string, unknown>) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncInbox)
        .set({ conflictDetail: detail })
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .returning();
      return row ? mapRow(row) : null;
    });
  }
}
