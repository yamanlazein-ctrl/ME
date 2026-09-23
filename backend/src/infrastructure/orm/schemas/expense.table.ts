import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  numeric,
  date,
  text,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: varchar("number", { length: 50 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    description: text("description").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    date: date("date").notNull(),
    method: varchar("method", { length: 20 }).notNull(),
    paidFromCashbox: boolean("paid_from_cashbox").notNull().default(true),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    notesPrint: text("notes_print"),
    notesInternal: text("notes_internal"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    /** REPAIR-008 B */
    clientOperationId: uuid("client_operation_id"),
  },
  (table) => ({
    tenantNumberIdx: uniqueIndex("idx_expenses_tenant_number").on(table.tenantId, table.number),
  }),
).enableRLS();
