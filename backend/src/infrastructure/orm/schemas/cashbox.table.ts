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
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const cashboxSessions = pgTable("cashbox_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  openingBalance: bigint("opening_balance", { mode: "number" }).notNull().default(0),
  openingDate: date("opening_date").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const manualMovements = pgTable("manual_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  date: date("date").notNull(),
  type: varchar("type", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
  description: text("description"),
  notesInternal: text("notes_internal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const dayCloses = pgTable(
  "day_closes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    date: date("date").notNull(),
    openingBalance: bigint("opening_balance", { mode: "number" }).notNull(),
    totalIn: bigint("total_in", { mode: "number" }).notNull(),
    totalOut: bigint("total_out", { mode: "number" }).notNull(),
    expected: bigint("expected", { mode: "number" }).notNull(),
    counted: bigint("counted", { mode: "number" }).notNull(),
    difference: bigint("difference", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid("closed_by"),
  },
  (table) => ({
    tenantDateIdx: uniqueIndex("idx_day_closes_tenant_date").on(table.tenantId, table.date),
  }),
);
