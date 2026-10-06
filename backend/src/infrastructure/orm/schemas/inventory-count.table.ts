import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  numeric,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { rolls } from "./roll.table.js";

/**
 * Physical inventory count, one row per (tenant, year, roll).
 *
 * `rolls` is the unit of stock in this schema (kg + pieces + price_per_kg), so
 * the count sheet is keyed by roll — no synthetic fabric/colour count layer is
 * invented on top of a model that does not have one.
 *
 * `bookKg` is snapshotted when the count line is opened so a sale made DURING
 * the count cannot silently rewrite what the counter physically saw. Posting a
 * variance never edits `rolls.remaining_kg` by hand: it goes through
 * `stock_movements` with `movement_type = 'adjustment'`, which is the same
 * append-only path every other stock change uses.
 */
export const inventoryCounts = pgTable(
  "inventory_counts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    year: integer("year").notNull(),
    rollId: uuid("roll_id")
      .notNull()
      .references(() => rolls.id),
    bookKg: numeric("book_kg", { precision: 14, scale: 2, mode: "number" }).notNull(),
    bookPieces: integer("book_pieces").notNull().default(0),
    countedKg: numeric("counted_kg", { precision: 14, scale: 2, mode: "number" }),
    countedPieces: integer("counted_pieces"),
    diffKg: numeric("diff_kg", { precision: 14, scale: 2, mode: "number" }),
    diffPieces: integer("diff_pieces"),
    status: varchar("status", { length: 20 }).notNull().default("counted"),
    reason: text("reason"),
    countedBy: uuid("counted_by"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedMovementId: uuid("posted_movement_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantYearRollIdx: uniqueIndex("inventory_counts_roll_year_key").on(
      table.tenantId,
      table.year,
      table.rollId,
    ),
    tenantYearStatusIdx: index("idx_inventory_counts_tenant_year").on(
      table.tenantId,
      table.year,
      table.status,
    ),
  }),
).enableRLS();

export type InventoryCountStatus = "counted" | "approved" | "posted" | "void";
