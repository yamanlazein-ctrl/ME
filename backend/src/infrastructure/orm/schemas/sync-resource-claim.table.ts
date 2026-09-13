import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  numeric,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * First-write-wins locks for sync resources (e.g. roll stock).
 * Arrival order on the hub (`claimed_at`) decides the winner.
 *
 * Two claim kinds coexist (P3a):
 * - identity guards (both quantities NULL): one winner per resource —
 *   voucher, order, expense and cancel namespaces where "how much" is
 *   meaningless.
 * - quantity reservations (either set): a second claim wins iff the reserved
 *   plus requested amounts fit hub stock in BOTH kilograms and pieces — the
 *   use-case guards both, so concurrent part-quantity sales of the same roll
 *   no longer conflict while piece shortages still do.
 */
export const syncResourceClaims = pgTable(
  "sync_resource_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    resourceType: varchar("resource_type", { length: 40 }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    quantityKg: numeric("quantity_kg", { precision: 14, scale: 3 }),
    quantityPieces: integer("quantity_pieces"),
    claimedByOpId: uuid("claimed_by_op_id").notNull(),
    claimedByDeviceId: uuid("claimed_by_device_id").references(() => syncDevices.id),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceUnique: uniqueIndex("uq_sync_claims_identity")
      .on(table.tenantId, table.resourceType, table.resourceId)
      .where(sql`quantity_kg IS NULL AND quantity_pieces IS NULL`),
    qtyOpUnique: uniqueIndex("uq_sync_claims_qty_op")
      .on(table.tenantId, table.resourceType, table.resourceId, table.claimedByOpId)
      .where(sql`quantity_kg IS NOT NULL OR quantity_pieces IS NOT NULL`),
    opIdx: index("idx_sync_resource_claims_op").on(table.tenantId, table.claimedByOpId),
    resourceQtyIdx: index("idx_sync_claims_resource_qty").on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
    ),
  }),
).enableRLS();
