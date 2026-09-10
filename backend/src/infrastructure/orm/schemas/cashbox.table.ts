import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  numeric,
  date,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const cashboxSessions = pgTable("cashbox_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  openingBalance: numeric("opening_balance", { precision: 14, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  openingDate: date("opening_date").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const manualMovements = pgTable("manual_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  date: date("date").notNull(),
  type: varchar("type", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
  description: text("description"),
  notesInternal: text("notes_internal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
}).enableRLS();

export const dayCloses = pgTable(
  "day_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    date: date("date").notNull(),
    openingBalance: numeric("opening_balance", {
      precision: 14,
      scale: 2,
      mode: "number",
    }).notNull(),
    totalIn: numeric("total_in", { precision: 14, scale: 2, mode: "number" }).notNull(),
    totalOut: numeric("total_out", { precision: 14, scale: 2, mode: "number" }).notNull(),
    expected: numeric("expected", { precision: 14, scale: 2, mode: "number" }).notNull(),
    counted: numeric("counted", { precision: 14, scale: 2, mode: "number" }).notNull(),
    difference: numeric("difference", { precision: 14, scale: 2, mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid("closed_by"),
  },
  (table) => ({
    tenantDateIdx: uniqueIndex("idx_day_closes_tenant_date").on(table.tenantId, table.date),
  }),
).enableRLS();
