import { pgTable, uuid, varchar, timestamp, decimal, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const fabrics = pgTable(
  "fabrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: varchar("name", { length: 255 }).notNull(),
    category: varchar("category", { length: 100 }),
    minStockKg: decimal("min_stock_kg", { precision: 12, scale: 2 }).default("0"),
    unit: varchar("unit", { length: 10 }),
    notes: text("notes"),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNameIdx: uniqueIndex("idx_fabrics_tenant_name").on(table.tenantId, table.name),
  }),
);
