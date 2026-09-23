import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  jsonb,
  index,
  uniqueIndex,
  bigserial,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * Local (and desktop) write queue for deferred sync to a central hub.
 * One row = one atomic business unit (e.g. invoice create with its side effects
 * described in payload). Replay/conflict resolution land in later phases.
 */
export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    syncDeviceId: uuid("sync_device_id").references(() => syncDevices.id),
    /** Client-generated idempotency key for the sync unit. */
    opId: uuid("op_id").notNull(),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: varchar("operation", { length: 20 }).notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    errorDetail: text("error_detail"),
    /**
     * Monotonic insertion order. `created_at` is transaction-start time, so
     * units enqueued in one transaction share it and cannot be ordered by it.
     * The hub must replay a device's units in the order they were recorded.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    // REPAIR-027: lease ownership so a stale worker cannot overwrite a newer outcome.
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => ({
    tenantStatusIdx: index("idx_sync_outbox_tenant_status").on(table.tenantId, table.status),
    tenantStatusSeqIdx: index("idx_sync_outbox_tenant_status_seq").on(
      table.tenantId,
      table.status,
      table.seq,
    ),
    leaseUntilIdx: index("idx_sync_outbox_lease_until").on(table.tenantId, table.leaseUntil),
    opUnique: uniqueIndex("uq_sync_outbox_tenant_op").on(table.tenantId, table.opId),
  }),
).enableRLS();
