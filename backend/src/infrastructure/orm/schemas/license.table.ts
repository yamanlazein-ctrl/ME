import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  text,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Licenses — one row per issued license key.
 *
 * Phase 0 model: server-side (License Server) and customer-side
 * (customer install) both have this table. The customer install
 * receives the row from the License Server during activation.
 *
 * The denormalized cache columns on `tenants.license_key` /
 * `tenants.license_expires_at` are kept in sync by the activation
 * and heartbeat flows; this table is the source of truth for
 * history / transfer / vendor metadata.
 */
export const licenses = pgTable(
  "licenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 64 }).notNull().unique(),
    type: varchar("type", { length: 20 }).notNull(), // trial | full | subscription
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | suspended | expired | revoked
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    graceDays: integer("grace_days").notNull().default(7),
    maxDevices: integer("max_devices").notNull().default(3),
    features: text("features").array().notNull().default([]),
    vendorId: varchar("vendor_id", { length: 64 }),
    vendorMetadata: jsonb("vendor_metadata"),
    // Cross-tenant anchor. The License Server writes a row that is
    // "system-level" (no tenant yet) before activation. After
    // activation, the license_activations row links it to a tenant.
    // RLS policy: tenant_id is null = system-level, visible to all
    // tenants for status checks (handled by a separate policy).
    tenantId: uuid("tenant_id").references(() => tenants.id),

    // ── License Engine extensions (frozen spec §3, §6) ──────────────
    // `edition`/`plan` are issuance-time inputs only. `features[]` (above)
    // is the runtime source of truth; `plan` is never read for gating.
    edition: varchar("edition", { length: 32 }),
    plan: varchar("plan", { length: 32 }),
    // Schema/interpretation version of the license itself (§3 license_version).
    licenseVersion: varchar("license_version", { length: 16 }).notNull().default("v1"),
    // Supported ERP product version range (§3 product_version).
    productVersion: varchar("product_version", { length: 16 }),
    // Explicit expiry model (§3.1): perpetual (expires_at=null) | subscription.
    licenseModel: varchar("license_model", { length: 16 }).notNull().default("perpetual"),
    // Abstract binding (§3 binding): machine | server | none | account.
    bindingType: varchar("binding_type", { length: 16 }),
    bindingValue: varchar("binding_value", { length: 255 }),
    // Numeric constraints, independent of features (§3 limits{}).
    limits: jsonb("limits").notNull().default("{}"),
    // Transfer governance (§3, §8 transfer_policy).
    transferPolicy: jsonb("transfer_policy")
      .notNull()
      .default({ allowed: true, max_transfers: 3, requires_super_admin: true }),
    // Auto-update governance for the Windows client (§3.2).
    updatePolicy: jsonb("update_policy")
      .notNull()
      .default({ channel: "stable", allow_updates: true, minimum_version: "1.0.0" }),
    // Backup entitlement (§3.3).
    backupPolicy: jsonb("backup_policy")
      .notNull()
      .default({ enabled: true, cloud_backup: false, max_backups: 30 }),
    // Number of completed transfers (enforced against transferPolicy.maxTransfers).
    transfersUsed: integer("transfers_used").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: uniqueIndex("idx_licenses_key").on(table.key),
    tenantIdx: index("idx_licenses_tenant").on(table.tenantId),
    statusIdx: index("idx_licenses_status").on(table.status),
  }),
);
