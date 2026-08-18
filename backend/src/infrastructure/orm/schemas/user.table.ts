import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    isLicenseOwner: boolean("is_license_owner").notNull().default(false),
    active: boolean("active").notNull().default(true),
    permissions: jsonb("permissions").default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmailIdx: uniqueIndex("idx_users_tenant_email").on(table.tenantId, table.email),
    licenseOwnerIdx: index("idx_users_license_owner").on(table.tenantId, table.isLicenseOwner),
  }),
);
