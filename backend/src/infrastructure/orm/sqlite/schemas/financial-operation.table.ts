// GENERATED (raw-SQL-only live table; columns from the fingerprint) by scripts/generate-sqlite-schema.mts from the PG Drizzle schema and the live
// schema fingerprint (specs/001-desktop-sqlite-engine T034). Do not edit by hand.
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { uuid, timestamptz, jsonb, nowDefault, randomUuid } from "../types.js";

export const financialOperations = sqliteTable(
  "financial_operations",
  {
    id: uuid("id").notNull().primaryKey().$defaultFn(randomUuid),
    tenantId: uuid("tenant_id").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    operationKey: text("operation_key").notNull(),
    statusCode: integer("status_code", { mode: "number" }).notNull(),
    responseBody: jsonb("response_body").notNull(),
    contentType: text("content_type").notNull().default("application/json; charset=utf-8"),
    createdAt: timestamptz("created_at").notNull().$defaultFn(nowDefault),
    updatedAt: timestamptz("updated_at").notNull().$defaultFn(nowDefault),
  },
);
