import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, timestamp, integer, jsonb, text } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  maxUsers: integer("max_users").notNull().default(5),
  ownerUserId: uuid("owner_user_id"),
  licenseKey: varchar("license_key", { length: 255 }),
  licenseExpiresAt: timestamp("license_expires_at", { withTimezone: true }),
  settings: jsonb("settings").default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // ── License Engine denormalized cache (migrations 0002/0005) ──
  licenseStatus: varchar("license_status", { length: 20 }).notNull().default("trial"),
  licenseType: varchar("license_type", { length: 20 }).notNull().default("trial"),
  maxDevices: integer("max_devices").notNull().default(3),
  activationId: uuid("activation_id"),
  serverFingerprint: varchar("server_fingerprint", { length: 128 }),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  licenseEdition: varchar("license_edition", { length: 32 }),
  licensePlan: varchar("license_plan", { length: 32 }),
  licenseVersion: varchar("license_version", { length: 16 }).notNull().default("v1"),
  productVersion: varchar("product_version", { length: 16 }),
  licenseModel: varchar("license_model", { length: 16 }).notNull().default("perpetual"),
  licenseFeatures: text("license_features")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  licenseLimits: jsonb("license_limits").default("{}"),
  licenseBindingType: varchar("license_binding_type", { length: 16 }),
  licenseBindingValue: varchar("license_binding_value", { length: 255 }),
  transferPolicy: jsonb("transfer_policy").default("{}"),
  updatePolicy: jsonb("update_policy").default("{}"),
  backupPolicy: jsonb("backup_policy").default("{}"),
  transfersUsed: integer("transfers_used").notNull().default(0),
});
