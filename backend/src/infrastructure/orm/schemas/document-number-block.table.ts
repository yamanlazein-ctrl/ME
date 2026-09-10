import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * Per-device reserved number ranges (Option B offline numbering).
 * Numbers are final at local issue time — never rewritten on sync.
 */
export const documentNumberBlocks = pgTable(
  "document_number_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    syncDeviceId: uuid("sync_device_id")
      .notNull()
      .references(() => syncDevices.id),
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    year: integer("year").notNull(),
    prefix: varchar("prefix", { length: 10 }).notNull(),
    startNumber: bigint("start_number", { mode: "number" }).notNull(),
    endNumber: bigint("end_number", { mode: "number" }).notNull(),
    nextNumber: bigint("next_number", { mode: "number" }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    reclaimedAt: timestamp("reclaimed_at", { withTimezone: true }),
  },
  (table) => ({
    tenantDeviceEntityIdx: index("idx_doc_num_blocks_tenant_device_entity").on(
      table.tenantId,
      table.syncDeviceId,
      table.entityType,
      table.status,
    ),
    rangeUnique: uniqueIndex("uq_doc_num_blocks_tenant_entity_year_start").on(
      table.tenantId,
      table.entityType,
      table.year,
      table.startNumber,
    ),
  }),
).enableRLS();
