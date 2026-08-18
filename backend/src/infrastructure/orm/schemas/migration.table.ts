import { pgTable, varchar, timestamp, text, boolean } from "drizzle-orm/pg-core";

export const schemaMigrations = pgTable("schema_migrations", {
  version: varchar("version", { length: 20 }).primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  appliedBy: varchar("applied_by", { length: 255 }),
  description: text("description"),
  checksum: varchar("checksum", { length: 64 }),
  success: boolean("success").notNull().default(true),
});
