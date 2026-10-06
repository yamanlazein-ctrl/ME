// PORTED-FROM: src/infrastructure/repositories/PostgresSyncOutboxRepository.ts sha256=e1d20ad846c4088f5a71678abc9a07421472a326a5cd8a5a0197fd9e7a42615f
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
import { asc, likeCs } from "./helpers/pgOrder.js";
import { transactionTimestamp, formatMicrosUtc, parseMicrosUtc } from "../../orm/sqlite/clock.js";
import { randomUuid } from "../../orm/sqlite/types.js";
import { pgRawRows } from "./helpers/pgText.js";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { runWithTenantContext } from "../../orm/tenant-context.js";
import type {
  EnqueueSyncOutboxInput,
  ISyncOutboxRepository,
  SyncOutboxRow,
  SyncOutboxStatus,
} from "../../../application/ports/ISyncOutboxRepository.js";
import { syncOutbox } from "../../orm/sqlite/schemas/sync-outbox.table.js";
import { syncDevices } from "../../orm/sqlite/schemas/sync-device.table.js";

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
    leaseToken: row.leaseToken ?? null,
    leaseOwner: row.leaseOwner ?? null,
    leaseUntil: row.leaseUntil ?? null,
  };
}

export class SqliteSyncOutboxRepository implements ISyncOutboxRepository {
  constructor(private readonly db: DB) {}

  async enqueue(input: EnqueueSyncOutboxInput): Promise<SyncOutboxRow> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const existing = await this.db
        .select()
        .from(syncOutbox)
        .where(and(eq(syncOutbox.tenantId, input.tenantId), eq(syncOutbox.opId, input.opId)))
        .limit(1);
      if (existing[0]) return mapRow(existing[0]);

      // Resolve device id BEFORE insert. A stale X-Sync-Device-Id that is not
      // in sync_devices would FK-fail the outbox row and — because this runs
      // inside the same withTenantTx as the business write — roll back the
      // invoice/party create too. Drop the reference instead of aborting.
      let syncDeviceId = input.syncDeviceId ?? null;
      if (syncDeviceId) {
        const device = await this.db
          .select({ id: syncDevices.id })
          .from(syncDevices)
          .where(and(eq(syncDevices.id, syncDeviceId), eq(syncDevices.tenantId, input.tenantId)))
          .limit(1);
        if (!device[0]) syncDeviceId = null;
      }

      const [row] = await this.db
        .insert(syncOutbox)
        .values({
          tenantId: input.tenantId,
          syncDeviceId,
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

  /**
   * REPAIR-007 / REPAIR-027: atomic claim with lease token.
   * PG: one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING. SQLite: the same steps
   * inside one gated transaction (no concurrent claimer can interleave); every row gets its own
   * lease token as gen_random_uuid() per row does; rows come back in PG's raw-execute shapes
   * (timestamptz as PG text, jsonb parsed).
   */
  async claimBatch(
    tenantId: string,
    limit: number,
    leaseMs: number,
    owner: string,
  ): Promise<SyncOutboxRow[]> {
    return runWithTenantContext({ tenantId }, () =>
      this.db.transaction(async (tx) => {
        const now = transactionTimestamp();
        const leaseUntil = formatMicrosUtc(parseMicrosUtc(now) + BigInt(Math.trunc(leaseMs)) * 1000n);
        const claimable = await tx.execute<{ id: string }>(sql`
          SELECT id FROM sync_outbox
           WHERE tenant_id = ${tenantId}
             AND (status = 'pending' OR (status = 'pushing' AND (lease_until IS NULL OR lease_until < ${now})))
           ORDER BY seq
           LIMIT ${limit}`);
        const ids = claimable.rows.map((r) => r.id);
        if (ids.length === 0) return [];
        for (const id of ids) {
          await tx.execute(sql`
            UPDATE sync_outbox
               SET status = 'pushing', lease_owner = ${owner}, lease_token = ${randomUuid()},
                   lease_until = ${leaseUntil}, claimed_at = ${now}, updated_at = ${now}
             WHERE id = ${id}`);
        }
        const result = await tx.execute<Record<string, unknown>>(sql`
          SELECT o.id, o.tenant_id AS "tenantId", o.sync_device_id AS "syncDeviceId",
                 o.op_id AS "opId", o.entity_type AS "entityType", o.entity_id AS "entityId",
                 o.operation, o.payload, o.status, o.error_detail AS "errorDetail", o.seq,
                 o.created_at AS "createdAt", o.updated_at AS "updatedAt", o.synced_at AS "syncedAt",
                 o.lease_owner AS "leaseOwner", o.lease_token AS "leaseToken",
                 o.lease_until AS "leaseUntil", o.claimed_at AS "claimedAt"
            FROM sync_outbox o
           WHERE o.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        const rows = pgRawRows(result.rows, { timestamps: ["createdAt", "updatedAt", "syncedAt", "leaseUntil", "claimedAt"] }).map(
          (r) => ({ ...r, payload: r.payload == null ? null : JSON.parse(String(r.payload)) }),
        ) as unknown as Array<typeof syncOutbox.$inferSelect>;
        return rows.map(mapRow).sort((a, b) => a.seq - b.seq);
      }),
    );
  }

  async markSynced(id: string, tenantId: string, leaseToken: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const result = await this.db
        .update(syncOutbox)
        .set({
          status: "synced",
          syncedAt: new Date(),
          updatedAt: new Date(),
          errorDetail: null,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(and(
          eq(syncOutbox.id, id),
          eq(syncOutbox.tenantId, tenantId),
          eq(syncOutbox.status, "pushing"),
          eq(syncOutbox.leaseToken, leaseToken),
        ));
      return (result as unknown as { changes?: number }).changes ?? 0; // PG rowCount = better-sqlite3 changes
    });
  }


  async acknowledgeByOpId(tenantId: string, opId: string): Promise<"acknowledged" | "settled" | "unknown"> {
    return runWithTenantContext({ tenantId }, async () => {
      const result = await this.db
        .update(syncOutbox)
        .set({
          status: "synced",
          syncedAt: new Date(),
          updatedAt: new Date(),
          errorDetail: null,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(and(
          eq(syncOutbox.tenantId, tenantId),
          eq(syncOutbox.opId, opId),
          inArray(syncOutbox.status, ["pending", "pushing", "rejected"]),
        ));
      if (((result as unknown as { changes?: number }).changes ?? 0) > 0) return "acknowledged";
      const [held] = await this.db
        .select({ id: syncOutbox.id })
        .from(syncOutbox)
        .where(and(eq(syncOutbox.tenantId, tenantId), eq(syncOutbox.opId, opId)))
        .limit(1);
      return held ? "settled" : "unknown";
    });
  }

  async markRejected(
    id: string,
    tenantId: string,
    errorDetail: string,
    leaseToken: string,
  ): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const result = await this.db
        .update(syncOutbox)
        .set({
          status: "rejected",
          errorDetail,
          updatedAt: new Date(),
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(and(
          eq(syncOutbox.id, id),
          eq(syncOutbox.tenantId, tenantId),
          eq(syncOutbox.status, "pushing"),
          eq(syncOutbox.leaseToken, leaseToken),
        ));
      return (result as unknown as { changes?: number }).changes ?? 0; // PG rowCount = better-sqlite3 changes
    });
  }

  async resetToPending(
    id: string,
    tenantId: string,
    errorDetail: string | undefined,
    leaseToken: string,
  ): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const result = await this.db
        .update(syncOutbox)
        .set({
          status: "pending",
          errorDetail: errorDetail ?? null,
          updatedAt: new Date(),
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
        })
        .where(and(
          eq(syncOutbox.id, id),
          eq(syncOutbox.tenantId, tenantId),
          eq(syncOutbox.status, "pushing"),
          eq(syncOutbox.leaseToken, leaseToken),
        ));
      return (result as unknown as { changes?: number }).changes ?? 0; // PG rowCount = better-sqlite3 changes
    });
  }

  async requeueSyncedForNewHub(tenantId: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .update(syncOutbox)
        .set({
          status: "pending",
          syncedAt: null,
          errorDetail: null,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncOutbox.tenantId, tenantId),
            // `hubDead:` rejections were parked by the OLD hub (e.g. a parent
            // it never received) and — unlike conflict losers — were NOT
            // rolled back locally: the document is live here, so the new hub
            // must get it too. Conflict/permanent rejections stay rejected.
            or(
              eq(syncOutbox.status, "synced"),
              and(eq(syncOutbox.status, "rejected"), likeCs(syncOutbox.errorDetail, "hubDead:%")),
            ),
          ),
        )
        .returning({ id: syncOutbox.id });
      return rows.length;
    });
  }

  async countOutstanding(tenantId: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)` })
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
        .select({ status: syncOutbox.status, c: sql<number>`count(*)` })
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
