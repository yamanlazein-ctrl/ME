import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  date,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: varchar("number", { length: 50 }).notNull(),
    type: varchar("type", { length: 10 }).notNull(),
    date: date("date").notNull(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    partyType: varchar("party_type", { length: 10 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    subtotal: bigint("subtotal", { mode: "number" }).notNull().default(0),
    discount: bigint("discount", { mode: "number" }).notNull().default(0),
    tax: bigint("tax", { mode: "number" }).notNull().default(0),
    shipping: bigint("shipping", { mode: "number" }).notNull().default(0),
    total: bigint("total", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancellationReferenceId: uuid("cancellation_reference_id"),
  },
  (table) => ({
    tenantTypeNumberIdx: uniqueIndex("idx_invoices_tenant_type_number").on(
      table.tenantId,
      table.type,
      table.number,
    ),
    partyIdx: index("idx_invoices_party").on(table.tenantId, table.partyId),
    dateIdx: index("idx_invoices_date").on(table.tenantId, table.date),
    statusIdx: index("idx_invoices_status").on(table.tenantId, table.status),
    currencyIdx: index("idx_invoices_currency").on(table.tenantId, table.currency),
    typeIdx: index("idx_invoices_type").on(table.tenantId, table.type),
    partyDateIdx: index("idx_invoices_party_date").on(
      table.tenantId,
      table.partyId,
      table.date,
    ),
    partyStatusIdx: index("idx_invoices_party_status").on(
      table.tenantId,
      table.partyId,
      table.status,
    ),
  }),
);
