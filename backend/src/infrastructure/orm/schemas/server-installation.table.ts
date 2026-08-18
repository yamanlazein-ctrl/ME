import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Server installations — one row per customer install.
 *
 * Populated on first boot of the customer's server. The
 * `installationId` is a UUID generated once and stored in
 * `/var/lib/erp/install-id` (or platform equivalent) so the
 * fingerprint stays stable across container restarts (see
 * PLATFORM_FOUNDATION_NOTES.md §4 in the validation report:
 * MAC-only fingerprinting is unstable).
 *
 * The unique constraint on `installationId` prevents duplicates
 * (e.g. if the on-disk file is copied between two hosts).
 */
export const serverInstallations = pgTable(
  "server_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    installationId: uuid("installation_id").notNull(),
    hostname: varchar("hostname", { length: 255 }),
    os: varchar("os", { length: 32 }),
    osVersion: varchar("os_version", { length: 64 }),
    appVersion: varchar("app_version", { length: 32 }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    installationIdIdx: uniqueIndex("idx_server_installations_installation_id").on(
      table.installationId,
    ),
    tenantIdx: index("idx_server_installations_tenant").on(table.tenantId),
  }),
);
