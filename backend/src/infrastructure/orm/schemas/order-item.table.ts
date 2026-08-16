import { pgTable, uuid, varchar, timestamp, decimal, text, index } from "drizzle-orm/pg-core";
import { orders } from "./order.table.js";
import { fabrics } from "./fabric.table.js";
import { colors } from "./color.table.js";
import { rolls } from "./roll.table.js";
import { tenants } from "./tenant.table.js";

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    fabricId: uuid("fabric_id").references(() => fabrics.id),
    fabricName: varchar("fabric_name", { length: 255 }).notNull(),
    colorId: uuid("color_id").references(() => colors.id),
    colorName: varchar("color_name", { length: 255 }).notNull(),
    colorCode: varchar("color_code", { length: 50 }),
    requestedKg: decimal("requested_kg", { precision: 12, scale: 2 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    // Pinned roll for this item (multi-roll support: one order item can reserve
    // one specific roll; more rolls = more items sharing the same color).
    rollId: uuid("roll_id").references(() => rolls.id),
    widthCm: decimal("width_cm", { precision: 7, scale: 2 }),
    weightGsm: decimal("weight_gsm", { precision: 7, scale: 2 }),
    notes: text("notes"),
  },
  (table) => ({
    rollIdx: index("idx_order_items_roll").on(table.tenantId, table.rollId),
  }),
);
