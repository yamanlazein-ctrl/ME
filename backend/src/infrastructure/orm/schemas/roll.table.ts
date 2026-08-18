import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  decimal,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { colors } from "./color.table.js";
import { parties } from "./party.table.js";

export const rolls = pgTable(
  "rolls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    colorId: uuid("color_id")
      .notNull()
      .references(() => colors.id),
    rollNo: varchar("roll_no", { length: 100 }).notNull(),
    dyeBatch: varchar("dye_batch", { length: 100 }),
    initialKg: decimal("initial_kg", { precision: 12, scale: 2 }).notNull(),
    remainingKg: decimal("remaining_kg", { precision: 12, scale: 2 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    pricePerKg: decimal("price_per_kg", { precision: 12, scale: 2 }).notNull(),
    salePricePerKg: decimal("sale_price_per_kg", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    supplierId: uuid("supplier_id").references(() => parties.id),
    entryDate: date("entry_date").notNull(),
    widthCm: decimal("width_cm", { precision: 7, scale: 2 }),
    weightGsm: decimal("weight_gsm", { precision: 7, scale: 2 }),
    status: varchar("status", { length: 20 }).notNull().default("in_stock"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantRollNoIdx: uniqueIndex("idx_rolls_tenant_roll_no").on(table.tenantId, table.rollNo),
    colorIdx: index("idx_rolls_color").on(table.tenantId, table.colorId),
    supplierIdx: index("idx_rolls_supplier").on(table.tenantId, table.supplierId),
    tenantStatusIdx: index("idx_rolls_tenant_status").on(table.tenantId, table.status),
  }),
);
