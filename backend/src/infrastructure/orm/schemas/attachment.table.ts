import { pgTable, uuid, varchar, timestamp, bigint, text } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: uuid("entity_id").notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  mimeType: varchar("mime_type", { length: 255 }),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  storageKey: varchar("storage_key", { length: 500 }).notNull(),
  storageUrl: text("storage_url"),
  uploadedBy: uuid("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
