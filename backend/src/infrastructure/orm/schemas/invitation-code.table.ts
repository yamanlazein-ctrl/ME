import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { users } from "./user.table.js";
import { licenses } from "./license.table.js";

export const invitationCodes = pgTable(
  "invitation_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    licenseId: uuid("license_id").references(() => licenses.id),
    code: varchar("code", { length: 16 }).notNull().unique(),
    type: varchar("type", { length: 10 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    licenseIdx: index("idx_invitation_codes_license").on(table.licenseId),
  }),
);
