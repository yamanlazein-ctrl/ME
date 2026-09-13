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
    /**
     * Batch 4 / 4B — the users this device is PROVISIONED for.
     *
     * `lastSeenByUserId` records whoever touched the row last (a transient
     * actor); authority over the device id must never be derived from it. A
     * device is usable by exactly the users listed here, and a user joins the
     * list only through an authenticated registration that proves possession
     * of the device (matching `device_fingerprint`) — see
     * PostgresSyncDeviceRepository.registerOrTouch. The sync transport gate
     * (sync-device-gate.middleware.ts) rejects a registered device asserted by
     * any other user, which is what makes a forged device id detectable.
     */
    authorizedUserIds: uuid("authorized_user_ids").array().notNull().default([]),
    /**
     * Revocation (operator action): a revoked device is refused on
     * registration, push and pull. Additive and non-destructive by design: the
     * row and every unit already attributed to it stay intact, so a revoke
     * removes authority to act — it never destroys data.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: varchar("revoke_reason", { length: 64 }),
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
