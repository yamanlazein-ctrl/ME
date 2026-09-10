import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * First-write-wins locks for sync resources (e.g. roll stock).
 * Arrival order on the hub (`claimed_at`) decides the winner.
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
    claimedByOpId: uuid("claimed_by_op_id").notNull(),
    claimedByDeviceId: uuid("claimed_by_device_id").references(() => syncDevices.id),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceUnique: uniqueIndex("uq_sync_resource_claims_tenant_resource").on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
    ),
    opIdx: index("idx_sync_resource_claims_op").on(table.tenantId, table.claimedByOpId),
  }),
).enableRLS();
