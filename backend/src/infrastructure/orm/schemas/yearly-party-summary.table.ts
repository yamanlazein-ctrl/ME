import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";

/**
 * Yearly party balance summary — one row per (party, year, currency).
 *
 * Why: When a user wants a 5-year statement, we don't scan 500,000 ledger rows.
 * Instead we show the opening balance per year (from this table) + only the
 * current year's detail rows from ledger_entries. The user can click "expand year"
 * to fetch archived rows from ledger_entry_archive if needed.
 *
 * This makes multi-year reports O(years) instead of O(rows).
 *
 * Updated automatically at year-end archive time (or on-demand).
 */
export const yearlyPartySummaries = pgTable(
  "yearly_party_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    year: integer("year").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    /** Balance at the START of this year (sum of all previous years). */
    openingBalance: real("opening_balance").notNull().default(0),
    /** Balance at the END of this year. */
    closingBalance: real("closing_balance").notNull().default(0),
    totalDebit: real("total_debit").notNull().default(0),
    totalCredit: real("total_credit").notNull().default(0),
    invoiceCount: integer("invoice_count").notNull().default(0),
    voucherCount: integer("voucher_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPartyYearCurrencyIdx: uniqueIndex("idx_yps_tenant_party_year_currency").on(
      table.tenantId,
      table.partyId,
      table.year,
      table.currency,
    ),
    tenantPartyIdx: index("idx_yps_party").on(table.tenantId, table.partyId),
    tenantYearIdx: index("idx_yps_year").on(table.tenantId, table.year),
  }),
);
