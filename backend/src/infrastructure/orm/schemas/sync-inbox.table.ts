import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  text,
  integer,
  index,
  uniqueIndex,
  bigserial,
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
    /** Materialization failure detail — kept separate from conflict provenance. */
    materializeError: jsonb("materialize_error").$type<Record<string, unknown>>(),
    applyAttempts: integer("apply_attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /**
     * Monotonic receive order — the pull cursor. `received_at` is
     * transaction-start time and therefore unusable as a cursor: rows written
     * in one transaction share it, so a strict `>` comparison skips them.
     */
    receivedSeq: bigserial("received_seq", { mode: "number" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    tenantIdx: index("idx_sync_inbox_tenant").on(table.tenantId),
    tenantStatusSeqIdx: index("idx_sync_inbox_tenant_status_received_seq").on(
      table.tenantId,
      table.status,
      table.receivedSeq,
    ),
    tenantDeviceSeqIdx: index("idx_sync_inbox_tenant_device_received_seq").on(
      table.tenantId,
      table.syncDeviceId,
      table.receivedSeq,
    ),
    opUnique: uniqueIndex("uq_sync_inbox_tenant_op").on(table.tenantId, table.opId),
  }),
).enableRLS();
