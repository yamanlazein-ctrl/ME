import {
  pgTable,
  uuid,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/** Per-tenant sync cursors (pull watermark). */
export const syncState = pgTable("sync_state", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
