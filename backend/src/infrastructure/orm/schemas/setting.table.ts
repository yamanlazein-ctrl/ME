import { pgTable, uuid, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const settings = pgTable("settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id)
    .unique(),
  company: jsonb("company").default("{}"),
  currencies: jsonb("currencies").default("[]"),
  paymentMethods: jsonb("payment_methods").default("[]"),
  taxes: jsonb("taxes").default("[]"),
  units: jsonb("units").default("[]"),
  warehouses: jsonb("warehouses").default("[]"),
  printing: jsonb("printing").default("{}"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
