import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";
import { ledgerEntries } from "./ledger-entry.table.js";

/**
 * Balance cache — materialized snapshot of a party's running balance per currency.
 *
 * Why: Without this table, every statement/kpi query scans ALL ledger_entries for
 * a party and re-aggregates debit-credit from scratch. With 10,000+ invoices
 * (50,000+ ledger rows) this becomes O(n) and takes 3-5 seconds.
 *
 * With party_balances: O(1) lookup for the current balance, and only the recent
 * delta rows (since last cache update) need to be scanned for the statement detail.
 *
 * Updated atomically inside the same transaction that posts the ledger entry,
 * so there is NEVER inconsistency between ledger_entries and party_balances.
 */
export const partyBalances = pgTable(
  "party_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    /** The last ledger entry id that was included in this balance. */
    lastEntryId: uuid("last_entry_id").references(() => ledgerEntries.id),
    /** The date of the last included ledger entry. */
    lastEntryDate: timestamp("last_entry_date", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPartyCurrencyIdx: uniqueIndex("idx_party_balances_tenant_party_currency").on(
      table.tenantId,
      table.partyId,
      table.currency,
    ),
    tenantPartyIdx: index("idx_party_balances_party").on(table.tenantId, table.partyId),
    tenantCurrencyIdx: index("idx_party_balances_currency").on(table.tenantId, table.currency),
  }),
);
