import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  date,
  text,
  uniqueIndex,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";
import { invoices } from "./invoice.table.js";

export const returns = pgTable(
  "returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: varchar("number", { length: 50 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(),
    date: date("date").notNull(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    originalInvoiceId: uuid("original_invoice_id").references(() => invoices.id),
    reason: varchar("reason", { length: 20 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    // Base-currency (USD) FX capture — frozen at creation time.
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6, mode: "number" }),
    baseTotal: numeric("base_total", { precision: 14, scale: 2, mode: "number" }),
    notesPrint: text("notes_print"),
    notesInternal: text("notes_internal"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    /** REPAIR-008 B */
    clientOperationId: uuid("client_operation_id"),
  },
  (table) => ({
    tenantKindNumberIdx: uniqueIndex("idx_returns_tenant_kind_number").on(
      table.tenantId,
      table.kind,
      table.number,
    ),
    // REPAIR-003
    originalInvoiceIdx: index("idx_returns_tenant_original_invoice").on(
      table.tenantId,
      table.originalInvoiceId,
    ),
  }),
).enableRLS();
