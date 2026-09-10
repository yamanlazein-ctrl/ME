import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { users } from "./user.table.js";

export const syncDevices = pgTable(
  "sync_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    lastSeenByUserId: uuid("last_seen_by_user_id").references(() => users.id),
    deviceFingerprint: varchar("device_fingerprint", { length: 128 }).notNull(),
    deviceFingerprintVersion: integer("device_fingerprint_version").notNull().default(1),
    platform: varchar("platform", { length: 16 }).notNull(),
    hostname: varchar("hostname", { length: 120 }),
    label: varchar("label", { length: 120 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index("idx_sync_devices_tenant").on(table.tenantId),
    userIdx: index("idx_sync_devices_last_seen_user").on(table.lastSeenByUserId),
    fingerprintUnique: uniqueIndex("uq_sync_devices_tenant_fingerprint").on(
      table.tenantId,
      table.deviceFingerprint,
    ),
  }),
).enableRLS();
