import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  date,
  text,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * The financial-year registry. One row per (tenant, year).
 *
 * Closing a year FREEZES it and records snapshots. It never moves, archives or
 * deletes a row of history: `invoices`, `ledger_entries`, `vouchers` and
 * `stock_movements` are all left exactly as they were, so a closed year stays
 * fully auditable and printable.
 *
 * The unique (tenant_id, year) constraint is what makes a double close
 * impossible at the database level — the application is not the only guard.
 *
 * `closingCashbox` / `closingInventoryValue` are PER-CURRENCY jsonb maps
 * (`{"SYP": 123, "USD": 45}`) read for display and audit. They are NOT written
 * back into the ledger: the drawer already carries forward continuously, and
 * posting an "opening cash" leg would double-count it under
 * `trg_cashbox_daily_from_ledger`.
 */
export const financialYears = pgTable(
  "financial_years",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    year: integer("year").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by"),
    reopenReason: text("reopen_reason"),
    closingCashbox: jsonb("closing_cashbox").notNull().default("{}"),
    closingInventoryValue: jsonb("closing_inventory_value").notNull().default("{}"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantYearIdx: uniqueIndex("financial_years_tenant_year_key").on(
      table.tenantId,
      table.year,
    ),
    tenantStatusIdx: index("idx_financial_years_tenant_status").on(
      table.tenantId,
      table.status,
    ),
  }),
).enableRLS();

export type FinancialYearStatus = "open" | "counting" | "ready" | "closed";
