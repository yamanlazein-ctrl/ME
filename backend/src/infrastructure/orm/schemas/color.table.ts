import { pgTable, uuid, varchar, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { fabrics } from "./fabric.table.js";

export const colors = pgTable(
  "colors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fabricId: uuid("fabric_id")
      .notNull()
      .references(() => fabrics.id),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 50 }),
    // Real visual color. Kept separate from `code` (code is a commercial /
    // product color identifier, NOT a hex value). Nullable for backward
    // compatibility — colors created before this column existed have no hex.
    hex: varchar("hex", { length: 9 }),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantFabricNameIdx: uniqueIndex("idx_colors_tenant_fabric_name").on(
      table.tenantId,
      table.fabricId,
      table.name,
    ),
  }),
);
