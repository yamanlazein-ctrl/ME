import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  ISyncInboxRepository,
  ReceiveSyncUnitInput,
  SyncInboxRow,
  SyncInboxStatus,
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
    materializeError: (row.materializeError as Record<string, unknown> | null) ?? null,
    applyAttempts: row.applyAttempts ?? 0,
    lastAttemptAt: row.lastAttemptAt ?? null,
    receivedSeq: Number(row.receivedSeq),
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

  /**
   * Cursor is `received_seq` (monotonic), not `received_at`.
   *
   * Two loss modes are closed here:
   *  1. `received_at` is transaction-start time, so concurrent inserts share it.
   *     A strict `>` against a timestamp cursor skips every row that ties with
   *     the cursor, permanently.
   *  2. A unit received before the cursor but applied after it was previously
   *     unreachable, because the cursor had already moved past its receive time.
   *
   * The excluded device is filtered IN SQL: post-filtering after the LIMIT let
   * the caller's own units fill the entire window, so a busy device could get
   * zero rows back forever and never advance its cursor.
   */
  async listAppliedSince(
    tenantId: string,
    afterSeq: number | null,
    opts?: { excludeSyncDeviceId?: string | null; limit?: number },
  ) {
    return runWithTenantContext({ tenantId }, async () => {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
      const conditions = [
        eq(syncInbox.tenantId, tenantId),
        eq(syncInbox.status, "applied"),
      ];
      if (afterSeq !== null && afterSeq !== undefined) {
        conditions.push(gt(syncInbox.receivedSeq, afterSeq));
      }
      if (opts?.excludeSyncDeviceId) {
        // Keep units whose device is unknown (NULL) — only exclude our own.
        conditions.push(
          or(
            isNull(syncInbox.syncDeviceId),
            ne(syncInbox.syncDeviceId, opts.excludeSyncDeviceId),
          )!,
        );
      }

      const rows = await this.db
        .select()
        .from(syncInbox)
        .where(and(...conditions))
        .orderBy(asc(syncInbox.receivedSeq))
        .limit(limit);

      return rows.map(mapRow);
    });
  }

  async setMaterializeError(tenantId: string, opId: string, detail: Record<string, unknown>) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncInbox)
        .set({
          materializeError: detail,
          applyAttempts: sql`${syncInbox.applyAttempts} + 1`,
          lastAttemptAt: new Date(),
        })
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .returning();
      return row ? mapRow(row) : null;
    });
  }

  async markDead(tenantId: string, opId: string, reason: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .update(syncInbox)
        .set({ status: "dead", rejectReason: reason, lastAttemptAt: new Date() })
        .where(and(eq(syncInbox.tenantId, tenantId), eq(syncInbox.opId, opId)))
        .returning();
      return row ? mapRow(row) : null;
    });
  }

  async countByStatus(tenantId: string): Promise<Record<SyncInboxStatus, number>> {
    const empty: Record<SyncInboxStatus, number> = {
      received: 0,
      applied: 0,
      rejected: 0,
      dead: 0,
    };
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select({ status: syncInbox.status, c: sql<number>`count(*)::int` })
        .from(syncInbox)
        .where(eq(syncInbox.tenantId, tenantId))
        .groupBy(syncInbox.status);
      for (const r of rows) {
        const key = r.status as SyncInboxStatus;
        if (key in empty) empty[key] = Number(r.c);
      }
      return empty;
    });
  }

  async listByStatus(
    tenantId: string,
    statuses: SyncInboxStatus[],
    limit = 100,
  ): Promise<SyncInboxRow[]> {
    if (statuses.length === 0) return [];
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncInbox)
        .where(and(eq(syncInbox.tenantId, tenantId), inArray(syncInbox.status, statuses)))
        .orderBy(asc(syncInbox.receivedSeq))
        .limit(limit);
      return rows.map(mapRow);
    });
  }
}
