/** PostgreSQL sync-state SQL — moved verbatim from syncUseCases.ts (S1). */
import { eq, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import { syncState } from "../orm/schemas/sync-state.table.js";
import type { ISyncStateStore } from "../../application/ports/ISyncStateStore.js";

export class PostgresSyncStateStore implements ISyncStateStore {
  constructor(private readonly db: DB) {}

  partyOpening(tenantId: string, partyId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const r = await this.db.execute(sql`
      SELECT p.opening_balance::float8 AS amount,
             (SELECT min(le.date)::text FROM ledger_entries le
               WHERE le.tenant_id = p.tenant_id AND le.reference_type = 'opening'
                 AND le.reference_id = p.id) AS date
        FROM parties p WHERE p.tenant_id = ${tenantId} AND p.id = ${partyId}::uuid`);
      const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{
        amount: number | null;
        date: string | null;
      }>;
      return rows[0];
    });
  }

  async resetPullCursor(tenantId: string): Promise<void> {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db.delete(syncState).where(eq(syncState.tenantId, tenantId));
    });
  }

  getPullCursor(tenantId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const [row] = await this.db
        .select()
        .from(syncState)
        .where(eq(syncState.tenantId, tenantId))
        .limit(1);
      return {
        lastPullSeq: row?.lastPullSeq ?? null,
        lastPullAt: row?.lastPullAt ?? null,
      };
    });
  }

  async setPullCursor(tenantId: string, seq: number, at: Date | null): Promise<void> {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .insert(syncState)
        .values({ tenantId, lastPullSeq: seq, lastPullAt: at, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [syncState.tenantId],
          set: { lastPullSeq: seq, lastPullAt: at, updatedAt: new Date() },
          setWhere: sql`sync_state.last_pull_seq IS NULL OR sync_state.last_pull_seq <= ${seq}`,
        });
    });
  }
}
