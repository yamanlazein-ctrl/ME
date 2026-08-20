import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  decimal,
  integer,
  bigint,
  text,
  index,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoice.table.js";
import { fabrics } from "./fabric.table.js";
import { colors } from "./color.table.js";
import { rolls } from "./roll.table.js";
import { tenants } from "./tenant.table.js";

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id),
    colorId: uuid("color_id")
      .notNull()
      .references(() => colors.id),
    rollId: uuid("roll_id")
      .notNull()
      .references(() => rolls.id),
    quantityKg: decimal("quantity_kg", { precision: 12, scale: 2 }).notNull(),
    pieces: integer("pieces").notNull().default(1),
    pricePerKg: decimal("price_per_kg", { precision: 12, scale: 2 }).notNull(),
    discountAmount: bigint("discount_amount", { mode: "number" }).notNull().default(0),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    invoiceIdx: index("idx_invoice_lines_invoice").on(table.tenantId, table.invoiceId),
    fabricIdx: index("idx_invoice_lines_fabric").on(table.tenantId, table.fabricId),
    colorIdx: index("idx_invoice_lines_color").on(table.tenantId, table.colorId),
    rollIdx: index("idx_invoice_lines_roll").on(table.tenantId, table.rollId),
  }),
);
