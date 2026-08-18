import {
  pgTable,
  bigserial,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { licenses } from "./license.table.js";

/**
 * License audit events — append-only security log for license-related
 * actions. Distinct from `audit_logs` (which is general business
 * change tracking). See PLATFORM_FOUNDATION_NOTES.md §1.
 *
 * Event types (kept as varchar, not enum, so vendors can add custom
 * values without a migration):
 *   activated | deactivated | device_added | device_revoked
 *   renewed | expired | hardware_changed | offline_grace_started
 *   vendor_sync | key_rotated | transfer_started | transfer_completed
 *
 * Append-only: enforced at the DB level by a trigger that raises on
 * UPDATE / DELETE (added in the migration SQL).
 */
export const licenseAuditEvents = pgTable(
  "license_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    licenseId: uuid("license_id").references(() => licenses.id),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    payload: jsonb("payload"),
    actor: varchar("actor", { length: 255 }),
    ipAddress: varchar("ip_address", { length: 45 }), // INET not used; text for IPv6 compat in Drizzle migrations
    requestId: varchar("request_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    licenseCreatedIdx: index("idx_license_audit_events_license_created").on(
      table.licenseId,
      table.createdAt,
    ),
    tenantCreatedIdx: index("idx_license_audit_events_tenant_created").on(
      table.tenantId,
      table.createdAt,
    ),
    eventTypeIdx: index("idx_license_audit_events_event_type").on(table.eventType),
  }),
);
