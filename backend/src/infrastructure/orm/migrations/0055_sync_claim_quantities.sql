-- Quantity-aware first-write-wins claims (P3a / SYNC-04).
--
-- Why this exists:
--   * Resource claims used to be whole-resource locks: ANY second invoice or
--     return touching the same roll was rejected as a conflict, even when the
--     roll held thousands of kilos and the two documents wanted ten each.
--     Legitimate concurrent sales were refused with no recourse.
--   * `quantity_kg` / `quantity_pieces` turn the claim into a reservation: a
--     second claim wins iff the already-reserved quantity plus the requested
--     quantity fits the hub's current stock (BOTH kilograms and pieces — the
--     use-case guards both, so the claim must measure both), evaluated inside
--     the same claim transaction while holding a row lock on the roll.
--     Over-claims are still rejected with the remaining figures in the
--     conflict detail.
--   * NULL quantities keep the old single-winner semantics for identity
--     guards (voucher/order/expense/cancel namespaces), where "how much" is
--     meaningless. The two semantics coexist via partial unique indexes:
--       - identity rows: at most one row per (tenant, type, resource);
--       - reservation rows: at most one row per (tenant, type, resource, op).
--   * Outstanding quantity is always measured against live hub stock, never
--     accumulated blindly: claims whose holder already applied are excluded
--     (their effect is in `remaining_kg`/`remaining_pieces`), so reservations
--     can neither double-count nor leak into permanent locks.

ALTER TABLE "sync_resource_claims" ADD COLUMN IF NOT EXISTS "quantity_kg" numeric(14, 3);
ALTER TABLE "sync_resource_claims" ADD COLUMN IF NOT EXISTS "quantity_pieces" integer;

-- The old whole-resource unique index cannot coexist with per-op quantity
-- rows: two operations may legitimately hold quantity reservations on the
-- same roll at the same time.
ALTER TABLE "sync_resource_claims" DROP CONSTRAINT IF EXISTS "uq_sync_resource_claims_tenant_resource";
DROP INDEX IF EXISTS "uq_sync_resource_claims_tenant_resource";
-- Re-create below (a pre-release amendment widened the predicates to cover
-- pieces: dropping first keeps re-migration idempotent on scratch databases
-- that saw the earlier predicate shape; production never received it).
DROP INDEX IF EXISTS "uq_sync_claims_identity";
DROP INDEX IF EXISTS "uq_sync_claims_qty_op";

-- Identity-guard rows (no quantities): one winner per resource, as before.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_claims_identity"
  ON "sync_resource_claims" ("tenant_id", "resource_type", "resource_id")
  WHERE "quantity_kg" IS NULL AND "quantity_pieces" IS NULL;

-- Reservation rows: one row per operation per resource (idempotent re-claim
-- by the same op, concurrent reservations by different ops).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_claims_qty_op"
  ON "sync_resource_claims" ("tenant_id", "resource_type", "resource_id", "claimed_by_op_id")
  WHERE "quantity_kg" IS NOT NULL OR "quantity_pieces" IS NOT NULL;

-- Operator visibility: outstanding reservations per resource.
CREATE INDEX IF NOT EXISTS "idx_sync_claims_resource_qty"
  ON "sync_resource_claims" ("tenant_id", "resource_type", "resource_id");
