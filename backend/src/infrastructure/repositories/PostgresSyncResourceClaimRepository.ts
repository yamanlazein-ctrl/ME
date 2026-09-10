import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  ISyncResourceClaimRepository,
  SyncResourceClaimRow,
  TryClaimResourcesInput,
  TryClaimResourcesResult,
} from "../../application/ports/ISyncResourceClaimRepository.js";
import { syncResourceClaims } from "../orm/schemas/sync-resource-claim.table.js";

function mapRow(row: typeof syncResourceClaims.$inferSelect): SyncResourceClaimRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    claimedByOpId: row.claimedByOpId,
    claimedByDeviceId: row.claimedByDeviceId,
    entityType: row.entityType,
    entityId: row.entityId,
    claimedAt: row.claimedAt,
  };
}

export class PostgresSyncResourceClaimRepository implements ISyncResourceClaimRepository {
  constructor(private readonly db: DB) {}

  async tryClaimAll(input: TryClaimResourcesInput): Promise<TryClaimResourcesResult> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      if (input.resources.length === 0) {
        return { ok: true, claims: [] };
      }

      // Deduplicate resources within the unit.
      const seen = new Set<string>();
      const resources = input.resources.filter((r) => {
        const key = `${r.resourceType}:${r.resourceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return this.db.transaction(async (tx) => {
        // Idempotent: same op already holds claims.
        const existingForOp = await tx
          .select()
          .from(syncResourceClaims)
          .where(
            and(
              eq(syncResourceClaims.tenantId, input.tenantId),
              eq(syncResourceClaims.claimedByOpId, input.opId),
            ),
          );
        if (existingForOp.length > 0) {
          return { ok: true, claims: existingForOp.map(mapRow) };
        }

        const resourceIds = resources.map((r) => r.resourceId);
        const held = await tx
          .select()
          .from(syncResourceClaims)
          .where(
            and(
              eq(syncResourceClaims.tenantId, input.tenantId),
              inArray(syncResourceClaims.resourceId, resourceIds),
            ),
          );

        const conflicts = held.filter((h) =>
          resources.some(
            (r) => r.resourceId === h.resourceId && r.resourceType === h.resourceType,
          ),
        );
        if (conflicts.length > 0) {
          return {
            ok: false as const,
            conflicts: conflicts.map((c) => ({
              resourceType: c.resourceType,
              resourceId: c.resourceId,
              claimedByOpId: c.claimedByOpId,
              claimedByDeviceId: c.claimedByDeviceId,
              entityType: c.entityType,
              entityId: c.entityId,
              claimedAt: c.claimedAt,
            })),
          };
        }

        try {
          const inserted = await tx
            .insert(syncResourceClaims)
            .values(
              resources.map((r) => ({
                tenantId: input.tenantId,
                resourceType: r.resourceType,
                resourceId: r.resourceId,
                claimedByOpId: input.opId,
                claimedByDeviceId: input.syncDeviceId ?? null,
                entityType: input.entityType,
                entityId: input.entityId,
              })),
            )
            .returning();

          return { ok: true as const, claims: inserted.map(mapRow) };
        } catch (err) {
          // Concurrent claim raced past the pre-check — unique index is the source of truth.
          const heldAfter = await tx
            .select()
            .from(syncResourceClaims)
            .where(
              and(
                eq(syncResourceClaims.tenantId, input.tenantId),
                inArray(syncResourceClaims.resourceId, resourceIds),
              ),
            );
          const conflicts = heldAfter.filter(
            (h) =>
              h.claimedByOpId !== input.opId &&
              resources.some(
                (r) => r.resourceId === h.resourceId && r.resourceType === h.resourceType,
              ),
          );
          if (conflicts.length > 0) {
            return {
              ok: false as const,
              conflicts: conflicts.map((c) => ({
                resourceType: c.resourceType,
                resourceId: c.resourceId,
                claimedByOpId: c.claimedByOpId,
                claimedByDeviceId: c.claimedByDeviceId,
                entityType: c.entityType,
                entityId: c.entityId,
                claimedAt: c.claimedAt,
              })),
            };
          }
          throw err;
        }
      });
    });
  }

  async listByOp(tenantId: string, opId: string): Promise<SyncResourceClaimRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncResourceClaims)
        .where(
          and(
            eq(syncResourceClaims.tenantId, tenantId),
            eq(syncResourceClaims.claimedByOpId, opId),
          ),
        );
      return rows.map(mapRow);
    });
  }
}
