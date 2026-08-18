import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  text,
  index,
} from "drizzle-orm/pg-core";
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
 * The "max_devices" cap from the parent license is enforced at the
 * application level (use-case checks count of non-revoked rows
 * before insert). There is no DB-level CHECK because the cap can
 * change at runtime.
 */
export const deviceRegistrations = pgTable(
  "device_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    licenseId: uuid("license_id")
      .notNull()
      .references(() => licenses.id),
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
    tenantIdx: index("idx_device_registrations_tenant").on(table.tenantId),
    // Fast lookup when a client hits /v1/activations/:id/devices.
    deviceIdIdx: index("idx_device_registrations_device_id").on(table.deviceId),
  }),
);
