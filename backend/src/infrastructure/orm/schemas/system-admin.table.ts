import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";

/**
 * System-level Super Admin identity.
 *
 * Distinct from tenant-scoped `users` (which only ever hold
 * admin/accountant/warehouse/viewer). A `system_admin` is the owner of the
 * platform: it creates companies, issues licenses, manages activation keys,
 * devices, transfers and revocations. It is NOT tenant-scoped and must never
 * gain access to a company's daily business data.
 *
 * Per the frozen Architecture Specification (§2.1, §6): `super_admin` is stored
 * separately from tenant users.
 */
export const systemAdmins = pgTable("system_admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  // system_roles = ["super_admin"]; kept as varchar for future system roles.
  role: varchar("role", { length: 20 }).notNull().default("super_admin"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
