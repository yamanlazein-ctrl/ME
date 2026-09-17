import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Server installations — canonical Installation registry (one row per install).
 *
 * Populated by `ensureServerInstallation` on activate/boot. The
 * `installationId` is the on-disk UUID from `InstallationIdStorage`
 * (`%ProgramData%\ERP\install-id` / `/var/lib/erp/install-id`). Device
 * fingerprints embed the same id as `hostHash::installationId`.
 *
 * Desktop DPAPI `device-binding.dat` is a separate integrity gate and is
 * not rewritten by this table.
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
).enableRLS();
