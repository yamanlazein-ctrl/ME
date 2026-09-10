import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * Central hub inbox — units received from peer devices.
 * Phase 4 stores them; Phase 6 applies FWW + use-case replay.
 */
export const syncInbox = pgTable(
  "sync_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    syncDeviceId: uuid("sync_device_id").references(() => syncDevices.id),
    opId: uuid("op_id").notNull(),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: varchar("operation", { length: 20 }).notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    status: varchar("status", { length: 20 }).notNull().default("received"),
    rejectReason: text("reject_reason"),
    conflictOpId: uuid("conflict_op_id"),
    conflictDetail: jsonb("conflict_detail").$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    tenantIdx: index("idx_sync_inbox_tenant").on(table.tenantId),
    opUnique: uniqueIndex("uq_sync_inbox_tenant_op").on(table.tenantId, table.opId),
  }),
).enableRLS();
