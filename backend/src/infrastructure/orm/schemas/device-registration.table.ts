import { pgTable, uuid, varchar, timestamp, integer, text, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenant.table.js";
import { licenses } from "./license.table.js";

/**
 * Device registrations — one row per (license, client device) pairing.
 *
 * Phase 0 ships the endpoint + admin UI only; the Tauri desktop / mobile
 * clients that consume it land in Phase 4. The signed_token column
 * stores the encrypted client-side token (encrypted at rest by
 * `secrets` table — see ISecretsRepository in 0B).
 *
 * The Max Devices cap from the parent License (`resolveDeviceLimit` —
 * `limits.devices` SoT with `max_devices` fallback) is enforced at the
 * application level before insert. There is no DB-level CHECK because the
 * cap can change at runtime via the Vendor Control Plane.
 *
 * DFP-013: license_id is bound via composite FK (tenant_id, license_id) so a
 * device cannot reference another tenant's license.
 */
export const deviceRegistrations = pgTable(
  "device_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    licenseId: uuid("license_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    deviceId: uuid("device_id").notNull(),
    deviceFingerprint: varchar("device_fingerprint", { length: 128 }).notNull(),
    deviceFingerprintVersion: integer("device_fingerprint_version").notNull().default(1),
    platform: varchar("platform", { length: 16 }).notNull(), // windows | macos | linux | android | ios | web
    name: varchar("name", { length: 100 }),
    signedToken: text("signed_token"),
    signedTokenExpiresAt: timestamp("signed_token_expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: varchar("revoke_reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    licenseIdx: index("idx_device_registrations_license").on(table.licenseId),
    liveFingerprintUidx: uniqueIndex("device_registrations_live_license_fingerprint_uidx")
      .on(table.licenseId, table.deviceFingerprint)
      .where(sql`revoked_at IS NULL`),
    tenantIdx: index("idx_device_registrations_tenant").on(table.tenantId),
    // Fast lookup when a client hits /v1/activations/:id/devices.
    deviceIdIdx: index("idx_device_registrations_device_id").on(table.deviceId),
    tenantLicenseFk: foreignKey({
      columns: [table.tenantId, table.licenseId],
      foreignColumns: [licenses.tenantId, licenses.id],
      name: "device_registrations_tenant_license_fk",
    }),
  }),
).enableRLS();
