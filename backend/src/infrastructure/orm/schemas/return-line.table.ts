import { pgTable, uuid, decimal, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { returns } from "./return.table.js";
import { rolls } from "./roll.table.js";

export const returnLines = pgTable(
  "return_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    returnId: uuid("return_id")
      .notNull()
      .references(() => returns.id, { onDelete: "cascade" }),
    rollId: uuid("roll_id")
      .notNull()
      .references(() => rolls.id),
    quantityKg: decimal("quantity_kg", { precision: 12, scale: 2 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    pricePerKg: decimal("price_per_kg", { precision: 12, scale: 2 }).notNull(),
  },
  (table) => ({
    returnRollIdx: uniqueIndex("idx_return_lines_return_roll").on(table.returnId, table.rollId),
  }),
);
