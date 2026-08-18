import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  date,
  text,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";

/**
 * Archived ledger entries — moved here from ledger_entries at year-end.
 *
 * Why: After 5 years a typical tenant has 500,000+ ledger rows. Scanning all of
 * them for every statement query is wasteful. We keep the current year in
 * ledger_entries (fast, hot) and move older years here (cold, still queryable).
 *
 * The schema is identical to ledger_entries so queries can UNION both tables
 * transparently when the user explicitly asks for "all years".
 */
export const ledgerEntryArchive = pgTable(
  "ledger_entry_archive",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    partyId: uuid("party_id").references(() => parties.id),
    date: date("date").notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    debit: bigint("debit", { mode: "number" }).default(0),
    credit: bigint("credit", { mode: "number" }).default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    cashImpact: varchar("cash_impact", { length: 10 }).notNull().default("none"),
    referenceType: varchar("reference_type", { length: 50 }),
    referenceId: uuid("reference_id"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancellationReferenceId: uuid("cancellation_reference_id"),
    /** The year this row was archived (for partitioning/filtering). */
    archiveYear: integer("archive_year").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPartyYearIdx: index("idx_archive_tenant_party_year").on(
      table.tenantId,
      table.partyId,
      table.archiveYear,
    ),
    tenantDateIdx: index("idx_archive_tenant_date").on(table.tenantId, table.date),
    tenantYearIdx: index("idx_archive_tenant_year").on(table.tenantId, table.archiveYear),
  }),
);
