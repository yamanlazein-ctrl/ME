import { pgTable, uuid, varchar, integer, bigint, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const documentSequences = pgTable(
  "document_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    entityType: varchar("entity_type", { length: 30 }).notNull(),
    prefix: varchar("prefix", { length: 10 }),
    lastNumber: bigint("last_number", { mode: "number" }).notNull().default(0),
  },
  (table) => ({
    tenantEntityPrefixIdx: uniqueIndex("idx_doc_seq_tenant_entity_prefix").on(
      table.tenantId,
      table.entityType,
      table.prefix,
    ),
  }),
);
