import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  date,
  numeric,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Company profiles — one row per tenant. Created by the Initial Setup
 * Wizard (sub-batch 0G). Holds the company-level configuration that
 * the plan scopes to Phase 0 only (logo, name, currency, language,
 * fiscal year, base tax, address, contact). Domain settings (units,
 * warehouses, payment methods, printing) move to Phase 1/3.
 *
 * Currency defaults to SYP (Syrian Pound — the project's market);
 * language defaults to "ar" (Arabic). Both are the design center
 * of the existing UI.
 *
 * `default_tax_rate` is `numeric(5,4)` to support both whole-percent
 * rates (0.0500 = 5%) and fractional rates (0.0825 = 8.25%).
 */
export const companyProfiles = pgTable(
  "company_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: varchar("name", { length: 255 }).notNull(),
    commercialReg: varchar("commercial_reg", { length: 100 }),
    taxNumber: varchar("tax_number", { length: 100 }),
    address: varchar("address", { length: 500 }),
    city: varchar("city", { length: 100 }),
    country: varchar("country", { length: 100 }),
    phone: varchar("phone", { length: 30 }),
    email: varchar("email", { length: 320 }),
    logoPath: varchar("logo_path", { length: 500 }),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    language: varchar("language", { length: 5 }).notNull().default("ar"),
    fiscalYearStart: date("fiscal_year_start"),
    defaultTaxRate: numeric("default_tax_rate", { precision: 5, scale: 4 })
      .notNull()
      .default("0.0000"),
    customization: jsonb("customization").default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: uniqueIndex("idx_company_profiles_tenant").on(table.tenantId),
  }),
);
