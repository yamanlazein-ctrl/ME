import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  real,
  date,
  text,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /* Nullable since F1: expenses (and other no-party ledger movements) write
       ledger rows with no party. Party-scoped queries (getBalance/listByParty)
       filter on party_id explicitly and are unaffected by NULL rows. */
    partyId: uuid("party_id").references(() => parties.id),
    date: date("date").notNull(),
    type: varchar("type", { length: 30 }).notNull(),
    debit: real("debit").default(0),
    credit: real("credit").default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    cashImpact: varchar("cash_impact", { length: 10 }).notNull().default("none"),
    referenceType: varchar("reference_type", { length: 50 }),
    referenceId: uuid("reference_id"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancellationReferenceId: uuid("cancellation_reference_id"),
  },
  (table) => ({
    partyIdx: index("idx_ledger_party").on(table.tenantId, table.partyId),
    referenceIdx: index("idx_ledger_reference").on(
      table.tenantId,
      table.referenceType,
      table.referenceId,
    ),
    dateIdx: index("idx_ledger_date").on(table.tenantId, table.date),
    typeIdx: index("idx_ledger_type").on(table.tenantId, table.type),
    currencyIdx: index("idx_ledger_currency").on(table.tenantId, table.currency),
    partyDateIdx: index("idx_ledger_party_date").on(
      table.tenantId,
      table.partyId,
      table.date,
    ),
    partyCurrencyIdx: index("idx_ledger_party_currency").on(
      table.tenantId,
      table.partyId,
      table.currency,
    ),
    partyDateCurrencyIdx: index("idx_ledger_party_date_currency").on(
      table.tenantId,
      table.partyId,
      table.date,
      table.currency,
    ),
  }),
);
