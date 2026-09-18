import { pgTable, uuid, timestamp, primaryKey, foreignKey, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { users } from "./user.table.js";
import { syncDevices } from "./sync-device.table.js";

/**
 * DFP-014 — relational device↔user authorization (source of truth).
 * `sync_devices.authorized_user_ids` is a denormalized cache rebuilt from this table.
 */
export const syncDeviceAuthorizedUsers = pgTable(
  "sync_device_authorized_users",
  {
    deviceId: uuid("device_id").notNull(),
    userId: uuid("user_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.deviceId, table.userId] }),
    userIdx: index("idx_sync_device_auth_users_user").on(table.tenantId, table.userId),
    deviceIdx: index("idx_sync_device_auth_users_device").on(table.tenantId, table.deviceId),
    deviceFk: foreignKey({
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [syncDevices.tenantId, syncDevices.id],
      name: "sync_device_authorized_users_device_fk",
    }).onDelete("cascade"),
    userFk: foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [users.tenantId, users.id],
      name: "sync_device_authorized_users_user_fk",
    }).onDelete("cascade"),
  }),
).enableRLS();
