import { pgTable, uuid, varchar, decimal, date, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { rolls } from "./roll.table.js";

/**
 * Stock Movement Ledger — append-only audit trail of every stock change on a
 * roll (invoice sale/entry, return, print send/receive, manual adjustment).
 * Written atomically inside the same transaction that mutates rolls.remaining_kg
 * so the movement can never diverge from the actual stock.
 */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    rollId: uuid("roll_id")
      .notNull()
      .references(() => rolls.id),
    // Direction of the change applied to remaining_kg: "in" | "out"
    direction: varchar("direction", { length: 10 }).notNull(),
    // Business event: invoice_sale | invoice_entry | return_sale | return_entry |
    // print_send | print_receive | adjustment | initial
    movementType: varchar("movement_type", { length: 30 }).notNull(),
    quantityKg: decimal("quantity_kg", { precision: 12, scale: 2 }).notNull(),
    // remaining_kg AFTER this movement (snapshot for auditability)
    balanceAfterKg: decimal("balance_after_kg", { precision: 12, scale: 2 }).notNull(),
    referenceType: varchar("reference_type", { length: 50 }),
    referenceId: uuid("reference_id"),
    referenceNumber: varchar("reference_number", { length: 100 }),
    movementDate: date("movement_date").notNull(),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rollIdx: index("idx_stock_movements_roll").on(table.tenantId, table.rollId),
    referenceIdx: index("idx_stock_movements_reference").on(
      table.tenantId,
      table.referenceType,
      table.referenceId,
    ),
    dateIdx: index("idx_stock_movements_date").on(table.tenantId, table.movementDate),
  }),
);
