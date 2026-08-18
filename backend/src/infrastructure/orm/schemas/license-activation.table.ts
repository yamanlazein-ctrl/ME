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
 * License activations — one row per (license, tenant) pairing.
 *
 * The "one active row per license" invariant (AD-5) is enforced by
 * a unique partial index added in the migration SQL:
 *   CREATE UNIQUE INDEX idx_license_activations_one_active
 *     ON license_activations (license_id)
 *     WHERE deactivated_at IS NULL;
 *
 * When a transfer happens, the old row is marked deactivated and a
 * new row is inserted; only one row is active at a time.
 */
export const licenseActivations = pgTable(
  "license_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    licenseId: uuid("license_id")
      .notNull()
      .references(() => licenses.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    serverFingerprint: varchar("server_fingerprint", { length: 128 }).notNull(),
    serverFingerprintVersion: integer("server_fingerprint_version").notNull().default(1),
    hostname: varchar("hostname", { length: 255 }),
    appVersion: varchar("app_version", { length: 32 }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivationReason: varchar("deactivation_reason", { length: 64 }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    licenseIdx: index("idx_license_activations_license").on(table.licenseId),
    tenantIdx: index("idx_license_activations_tenant").on(table.tenantId),
    // The "one active" partial index is created in the migration SQL,
    // not here, because Drizzle does not expose partial indexes
    // declaratively.
  }),
);

// Re-exported for the migration's partial-index reference.
export { licenses as _licensesRef };
