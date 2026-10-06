// GENERATED (raw-SQL-only live table; columns from the fingerprint) by scripts/generate-sqlite-schema.mts from the PG Drizzle schema and the live
// schema fingerprint (specs/001-desktop-sqlite-engine T034). Do not edit by hand.
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { uuid, timestamptz, nowDefault, randomUuid } from "../types.js";

export const syncTombstones = sqliteTable(
  "sync_tombstones",
  {
    id: uuid("id").notNull().primaryKey().$defaultFn(randomUuid),
    tenantId: uuid("tenant_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    deletedByDeviceId: uuid("deleted_by_device_id"),
    opId: uuid("op_id").notNull(),
    deletionSeq: integer("deletion_seq", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").notNull().$defaultFn(nowDefault),
    deletedEntityVersion: integer("deleted_entity_version", { mode: "number" }).notNull().default(1),
  },
);
