import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  date,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";
import { invoices } from "./invoice.table.js";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    code: varchar("code", { length: 50 }).notNull(),
    customerId: uuid("customer_id").references(() => parties.id),
    customerNameSnapshot: varchar("customer_name_snapshot", { length: 255 }).notNull(),
    customerPhoneSnapshot: varchar("customer_phone_snapshot", { length: 30 }),
    date: date("date").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    notes: text("notes"),
    fulfilledInvoiceId: uuid("fulfilled_invoice_id").references(() => invoices.id),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCodeIdx: uniqueIndex("idx_orders_tenant_code").on(table.tenantId, table.code),
  }),
);
