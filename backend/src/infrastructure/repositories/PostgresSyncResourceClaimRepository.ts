import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  ISyncResourceClaimRepository,
  SyncResourceClaimRow,
  TryClaimResourcesInput,
  TryClaimResourcesResult,
} from "../../application/ports/ISyncResourceClaimRepository.js";
import { syncResourceClaims } from "../orm/schemas/sync-resource-claim.table.js";
import { syncInbox } from "../orm/schemas/sync-inbox.table.js";
import { rolls } from "../orm/schemas/roll.table.js";

function mapRow(row: typeof syncResourceClaims.$inferSelect): SyncResourceClaimRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    quantityKg: row.quantityKg != null ? Number(row.quantityKg) : null,
    quantityPieces: row.quantityPieces != null ? Number(row.quantityPieces) : null,
    claimedByOpId: row.claimedByOpId,
    claimedByDeviceId: row.claimedByDeviceId,
    entityType: row.entityType,
    entityId: row.entityId,
    claimedAt: row.claimedAt,
  };
}

/** Stock-bearing claim namespaces: reservations measured in kilograms. */
const STOCK_RESOURCE_TYPES = new Set(["roll", "invoice_update_roll", "return_roll"]);

type MergedResource = {
  resourceType: string;
  resourceId: string;
  quantityKg: number | null;
  quantityPieces: number | null;
};

function validQty(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Merge duplicate resources within one unit, summing reservations per
 * dimension (two lines on the same roll reserve their totals). A dimension
 * requested once without a quantity (legacy payload without lines) stays
 * unquantified for that dimension; a resource is whole-resource only when
 * BOTH dimensions are unquantified — the pre-P3a behavior, never zero.
 */
function mergeResources(resources: TryClaimResourcesInput["resources"]): MergedResource[] {
  const byKey = new Map<string, MergedResource>();
  for (const r of resources) {
    const key = `${r.resourceType}:${r.resourceId}`;
    const kg = validQty(r.quantityKg);
    const pc = validQty(r.quantityPieces);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        quantityKg: kg,
        quantityPieces: pc,
      });
    } else {
      if (prev.quantityKg === null || kg === null) prev.quantityKg = null;
      else prev.quantityKg = prev.quantityKg + kg;
      if (prev.quantityPieces === null || pc === null) prev.quantityPieces = null;
      else prev.quantityPieces = prev.quantityPieces + pc;
    }
  }
  return [...byKey.values()];
}

export class PostgresSyncResourceClaimRepository implements ISyncResourceClaimRepository {
  constructor(private readonly db: DB) {}

  async tryClaimAll(input: TryClaimResourcesInput): Promise<TryClaimResourcesResult> {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      if (input.resources.length === 0) {
        return { ok: true, claims: [] };
      }

      // Merge duplicate resources within the unit, summing kilogram
      // reservations (two lines on the same roll reserve their total).
      const resources = mergeResources(input.resources);

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

        // ---- Whole-resource requests: classic single-winner check. ----
        // A resource is whole-resource only when BOTH dimensions are
        // unquantified (identity namespaces, or legacy payloads without
        // lines). It cannot be measured, so ANY holder blocks it — the
        // pre-P3a behavior, preserved exactly for these rows.
        const whole = resources.filter((r) => r.quantityKg === null && r.quantityPieces === null);
        if (whole.length > 0) {
          const held = await tx
            .select()
            .from(syncResourceClaims)
            .where(
              and(
                eq(syncResourceClaims.tenantId, input.tenantId),
                inArray(
                  syncResourceClaims.resourceId,
                  whole.map((r) => r.resourceId),
                ),
              ),
            );
          const holderOps = [...new Set(held.map((h) => h.claimedByOpId))].filter(
            (op) => op !== input.opId,
          );
          const settled = new Set<string>();
          if (holderOps.length > 0) {
            const states = await tx
              .select({ opId: syncInbox.opId, status: syncInbox.status })
              .from(syncInbox)
              .where(
                and(eq(syncInbox.tenantId, input.tenantId), inArray(syncInbox.opId, holderOps)),
              );
            for (const s of states) {
              if (s.status === "applied" || s.status === "dead") settled.add(s.opId);
            }
          }
          const conflicts = held.filter(
            (h) =>
              h.claimedByOpId !== input.opId &&
              !settled.has(h.claimedByOpId) &&
              whole.some((r) => r.resourceId === h.resourceId && r.resourceType === h.resourceType),
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
        }

        // ---- Quantity reservations: measure against live hub stock. ----
        // For each requested (roll, kg, pieces): lock the hub roll row
        // (serializes concurrent claim transactions), sum outstanding
        // reservations whose holders have NOT applied (applied holders'
        // effect is already in remaining_kg/remaining_pieces; dead holders
        // never retry), and fit requested inside the remainder in BOTH
        // dimensions — the use-case guards both. A missing roll row means its
        // dependency snapshot is still in flight — reserve unchecked and let
        // materialization's ensure+replay (or a retryable failure) decide,
        // never a 409.
        // The fit check ALWAYS runs when holders are settled-or-absent too:
        // with no live blocker the stock itself is the constraint (a sale
        // bigger than the roll is insufficient stock, not a grant).
        const stock = resources.filter((r) => r.quantityKg !== null || r.quantityPieces !== null);
        const stockConflicts: Array<{
          resourceType: string;
          resourceId: string;
          claimedByOpId: string;
          claimedByDeviceId: string | null;
          entityType: string;
          entityId: string;
          claimedAt: Date;
          availableKg: number | null;
          requestedKg: number | null;
          availablePieces: number | null;
          requestedPieces: number | null;
          reason: "held" | "insufficient-stock";
        }> = [];
        const stockInserts: MergedResource[] = [];
        for (const r of stock) {
          const requestedKg = r.quantityKg ?? 0;
          const requestedPc = r.quantityPieces ?? 0;
          if (!STOCK_RESOURCE_TYPES.has(r.resourceType)) {
            // A quantity on a non-stock namespace is meaningless — fall back
            // to whole-resource semantics for that row.
            const held = await tx
              .select()
              .from(syncResourceClaims)
              .where(
                and(
                  eq(syncResourceClaims.tenantId, input.tenantId),
                  eq(syncResourceClaims.resourceType, r.resourceType),
                  eq(syncResourceClaims.resourceId, r.resourceId),
                ),
              );
            const blocker = held.find((h) => h.claimedByOpId !== input.opId);
            if (blocker) {
              stockConflicts.push({
                resourceType: blocker.resourceType,
                resourceId: blocker.resourceId,
                claimedByOpId: blocker.claimedByOpId,
                claimedByDeviceId: blocker.claimedByDeviceId,
                entityType: blocker.entityType,
                entityId: blocker.entityId,
                claimedAt: blocker.claimedAt,
                availableKg: null,
                requestedKg,
                availablePieces: null,
                requestedPieces: requestedPc,
                reason: "held",
              });
            } else {
              stockInserts.push({ ...r, quantityKg: null, quantityPieces: null });
            }
            continue;
          }
          const [roll] = await tx
            .select({ remainingKg: rolls.remainingKg, remainingPieces: rolls.remainingPieces })
            .from(rolls)
            .where(and(eq(rolls.tenantId, input.tenantId), eq(rolls.id, r.resourceId)))
            .for("update")
            .limit(1);
          if (!roll) {
            stockInserts.push(r);
            continue;
          }
          const heldRows = await tx
            .select()
            .from(syncResourceClaims)
            .where(
              and(
                eq(syncResourceClaims.tenantId, input.tenantId),
                eq(syncResourceClaims.resourceType, r.resourceType),
                eq(syncResourceClaims.resourceId, r.resourceId),
              ),
            );
          const otherHolders = [...new Set(heldRows.map((h) => h.claimedByOpId))].filter(
            (op) => op !== input.opId,
          );
          const settled = new Set<string>();
          if (otherHolders.length > 0) {
            const states = await tx
              .select({ opId: syncInbox.opId, status: syncInbox.status })
              .from(syncInbox)
              .where(
                and(eq(syncInbox.tenantId, input.tenantId), inArray(syncInbox.opId, otherHolders)),
              );
            for (const s of states) {
              // Applied holders already decremented remaining_kg; dead holders
              // never retry. Both must be excluded or reservations
              // double-count and leak into permanent locks.
              if (s.status === "applied" || s.status === "dead") settled.add(s.opId);
            }
          }
          let outstandingKg = 0;
          let outstandingPc = 0;
          let firstLive: (typeof heldRows)[number] | null = null;
          let wholeBlocker: (typeof heldRows)[number] | null = null;
          let latestHeld: (typeof heldRows)[number] | null = null;
          for (const h of heldRows) {
            latestHeld = h;
            if (h.claimedByOpId === input.opId || settled.has(h.claimedByOpId)) continue;
            if (h.quantityKg == null && h.quantityPieces == null) {
              // A whole-resource reservation cannot be measured against —
              // it blocks quantification, conservatively.
              wholeBlocker ??= h;
              continue;
            }
            outstandingKg += Number(h.quantityKg ?? 0);
            outstandingPc += Number(h.quantityPieces ?? 0);
            firstLive ??= h;
          }
          const remainingKg = Number(roll.remainingKg);
          const remainingPc = Number(roll.remainingPieces);
          // Returns ADD stock, so neither their own nor other returns'
          // amounts consume availability (every return only increases what a
          // sale may later use). Recorded amounts stay for visibility.
          const isReturn = r.resourceType === "return_roll";
          const effOutKg = isReturn ? 0 : outstandingKg;
          const effOutPc = isReturn ? 0 : outstandingPc;
          const effReqKg = isReturn ? 0 : requestedKg;
          const effReqPc = isReturn ? 0 : requestedPc;
          // Dimensions the request did not quantify are not checked against —
          // only whole-resource rows (handled above) constrain blindly.
          const kgFits = r.quantityKg == null || effOutKg + effReqKg <= remainingKg + 1e-9;
          const pcFits = r.quantityPieces == null || effOutPc + effReqPc <= remainingPc + 1e-9;
          // THE fit check runs unconditionally: with no live blocker the stock
          // itself is the constraint — a sale bigger than the roll is
          // insufficient stock, not a grant. (This was the T2b gate failure:
          // settled-only holders skipped the check entirely.)
          if (wholeBlocker || !kgFits || !pcFits) {
            // Reporter preference: the whole blocker, then a live holder,
            // then the latest settled holder for context. With no holder at
            // all the roll itself is the reporter (insufficient-stock).
            const reporter = wholeBlocker ?? firstLive ?? latestHeld ?? null;
            const availableKg = wholeBlocker ? null : remainingKg - outstandingKg;
            const availablePc = wholeBlocker ? null : remainingPc - outstandingPc;
            if (reporter) {
              stockConflicts.push({
                resourceType: reporter.resourceType,
                resourceId: reporter.resourceId,
                claimedByOpId: reporter.claimedByOpId,
                claimedByDeviceId: reporter.claimedByDeviceId,
                entityType: reporter.entityType,
                entityId: reporter.entityId,
                claimedAt: reporter.claimedAt,
                availableKg,
                requestedKg,
                availablePieces: availablePc,
                requestedPieces: requestedPc,
                reason: "held",
              });
            } else {
              stockConflicts.push({
                resourceType: r.resourceType,
                resourceId: r.resourceId,
                claimedByOpId: input.opId,
                claimedByDeviceId: input.syncDeviceId ?? null,
                entityType: "roll",
                entityId: r.resourceId,
                claimedAt: new Date(),
                availableKg: remainingKg,
                requestedKg,
                availablePieces: remainingPc,
                requestedPieces: requestedPc,
                reason: "insufficient-stock",
              });
            }
          } else {
            stockInserts.push(r);
          }
        }
        if (stockConflicts.length > 0) {
          return { ok: false as const, conflicts: stockConflicts };
        }

        /**
         * Release SETTLED identity rows before inserting.
         *
         * The whole-resource pre-check above already lets a request through
         * when every existing holder is settled (applied/dead) — those holders
         * never retry and their effect is persisted. But the row itself stays,
         * and `uq_sync_claims_identity` is unique on
         * (tenant, resource_type, resource_id) for NULL-quantity rows. So the
         * insert hit a unique violation and the catch below reported the
         * settled holder as a live conflict: an applied holder became a
         * PERMANENT lock, and every later settlement/party update on that
         * resource failed with a 409 that could never clear.
         */
        if (whole.length > 0) {
          const staleIdentity = await tx
            .select({ id: syncResourceClaims.id, opId: syncResourceClaims.claimedByOpId })
            .from(syncResourceClaims)
            .where(
              and(
                eq(syncResourceClaims.tenantId, input.tenantId),
                inArray(
                  syncResourceClaims.resourceId,
                  whole.map((r) => r.resourceId),
                ),
                isNull(syncResourceClaims.quantityKg),
                isNull(syncResourceClaims.quantityPieces),
              ),
            );
          const removable = staleIdentity
            .filter((h) => h.opId !== input.opId)
            .map((h) => h.id);
          if (removable.length > 0) {
            await tx
              .delete(syncResourceClaims)
              .where(inArray(syncResourceClaims.id, removable));
          }
        }

        try {
          /**
           * The insert runs in a SAVEPOINT. On a unique-violation PostgreSQL
           * aborts the whole transaction, and every later statement in it fails
           * with 25P02 "current transaction is aborted" — which is exactly what
           * the conflict lookup below used to hit, so a legitimate concurrent
           * claim surfaced as HTTP 500 and the loser was retried forever
           * instead of being told it lost. Rolling back only the savepoint
           * keeps the outer transaction usable for the conflict read.
           */
          // Whole-resource rows carry NULL quantity (single-winner semantics);
          // stock rows carry their kilogram reservation. Both insert kinds
          // share one savepoint so a concurrent-identity-claim race rolls back
          // only the savepoint and re-reads (see catch below).
          const rowsToInsert = [
            ...whole.map((r) => ({ ...r, quantityKg: null as number | null })),
            ...stockInserts,
          ];
          const inserted = await tx.transaction(async (tx2) =>
            tx2
              .insert(syncResourceClaims)
              .values(
                rowsToInsert.map((r) => ({
                  tenantId: input.tenantId,
                  resourceType: r.resourceType,
                  resourceId: r.resourceId,
                  quantityKg: r.quantityKg != null ? String(r.quantityKg) : null,
                  quantityPieces: r.quantityPieces ?? null,
                  claimedByOpId: input.opId,
                  claimedByDeviceId: input.syncDeviceId ?? null,
                  entityType: input.entityType,
                  entityId: input.entityId,
                })),
              )
              .returning(),
          );

          return { ok: true as const, claims: inserted.map(mapRow) };
        } catch (err) {
          // Concurrent claim raced past the pre-check — unique index is the source of truth.
          const heldAfter = await tx
            .select()
            .from(syncResourceClaims)
            .where(
              and(
                eq(syncResourceClaims.tenantId, input.tenantId),
                inArray(
                  syncResourceClaims.resourceId,
                  resources.map((r) => r.resourceId),
                ),
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

  /**
   * F-08: claims were never released, so a cancelled invoice kept its rolls
   * reserved forever and every later sale of those rolls was rejected as a
   * conflict. Releasing by (entityType, entityId) targets the document that
   * holds the claim, not the cancel unit (which carries a different opId).
   */
  async releaseByEntity(
    tenantId: string,
    entityType: string,
    entityId: string,
    resourceTypes?: string[],
  ): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const conditions = [
        eq(syncResourceClaims.tenantId, tenantId),
        eq(syncResourceClaims.entityType, entityType),
        eq(syncResourceClaims.entityId, entityId),
      ];
      if (resourceTypes && resourceTypes.length > 0) {
        conditions.push(inArray(syncResourceClaims.resourceType, resourceTypes));
      }
      const removed = await this.db
        .delete(syncResourceClaims)
        .where(and(...conditions))
        .returning({ id: syncResourceClaims.id });
      return removed.length;
    });
  }

  async listByTenant(tenantId: string, limit = 5000): Promise<SyncResourceClaimRow[]> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(syncResourceClaims)
        .where(eq(syncResourceClaims.tenantId, tenantId))
        .orderBy(asc(syncResourceClaims.claimedAt))
        .limit(limit);
      return rows.map(mapRow);
    });
  }

  async releaseByOp(tenantId: string, opId: string): Promise<number> {
    return runWithTenantContext({ tenantId }, async () => {
      const removed = await this.db
        .delete(syncResourceClaims)
        .where(
          and(
            eq(syncResourceClaims.tenantId, tenantId),
            eq(syncResourceClaims.claimedByOpId, opId),
          ),
        )
        .returning({ id: syncResourceClaims.id });
      return removed.length;
    });
  }
}
