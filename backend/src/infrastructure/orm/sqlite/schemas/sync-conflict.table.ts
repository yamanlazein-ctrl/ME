// GENERATED (raw-SQL-only live table; columns from the fingerprint) by scripts/generate-sqlite-schema.mts from the PG Drizzle schema and the live
// schema fingerprint (specs/001-desktop-sqlite-engine T034). Do not edit by hand.
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { uuid, timestamptz, jsonb, nowDefault, randomUuid } from "../types.js";

export const syncConflicts = sqliteTable(
  "sync_conflicts",
  {
    id: uuid("id").notNull().primaryKey().$defaultFn(randomUuid),
    tenantId: uuid("tenant_id").notNull(),
    opId: uuid("op_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    operation: text("operation").notNull(),
    baseVersion: integer("base_version", { mode: "number" }),
    serverVersion: integer("server_version", { mode: "number" }),
    localIntent: jsonb("local_intent").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(nowDefault),
    resolvedAt: timestamptz("resolved_at"),
    resolution: jsonb("resolution"),
  },
);
