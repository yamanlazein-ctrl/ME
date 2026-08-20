import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  decimal,
  integer,
  date,
  text,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { rolls } from "./roll.table.js";
import { parties } from "./party.table.js";
import { orders } from "./order.table.js";
import { expenses } from "./expense.table.js";

export const printJobs = pgTable(
  "print_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    date: date("date").notNull(),
    number: varchar("number", { length: 32 }),
    status: varchar("status", { length: 10 }).notNull().default("sent"),
    sourceRollId: uuid("source_roll_id")
      .notNull()
      .references(() => rolls.id),
    sourceFabricId: uuid("source_fabric_id"),
    sourceColorId: uuid("source_color_id"),
    quantityKg: decimal("quantity_kg", { precision: 12, scale: 2 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    pressName: varchar("press_name", { length: 255 }),
    printCostPerKg: decimal("print_cost_per_kg", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    newName: varchar("new_name", { length: 255 }),
    newCategory: varchar("new_category", { length: 100 }),
    newColorName: varchar("new_color_name", { length: 255 }),
    newColorCode: varchar("new_color_code", { length: 50 }),
    newSalePricePerKg: decimal("new_sale_price_per_kg", { precision: 12, scale: 2 }),
    receivedKg: decimal("received_kg", { precision: 12, scale: 2 }),
    resultRollId: uuid("result_roll_id").references(() => rolls.id),
    resultFabricId: uuid("result_fabric_id"),
    resultColorId: uuid("result_color_id"),
    receiveNotes: text("receive_notes"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    customerId: uuid("customer_id").references(() => parties.id),
    orderId: uuid("order_id").references(() => orders.id),
    chargePerKg: decimal("charge_per_kg", { precision: 12, scale: 2 }),
    costExpenseId: uuid("cost_expense_id").references(() => expenses.id),
  },
  (table) => ({
    customerIdx: index("idx_print_jobs_customer").on(table.tenantId, table.customerId),
    orderIdx: index("idx_print_jobs_order").on(table.tenantId, table.orderId),
  }),
);
