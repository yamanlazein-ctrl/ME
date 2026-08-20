import {
  pgTable,
  bigserial,
  uuid,
  varchar,
  timestamp,
  inet,
  jsonb,
  text,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    actorId: uuid("actor_id"),
    actorName: varchar("actor_name", { length: 255 }),
    module: varchar("module", { length: 50 }).notNull(),
    action: varchar("action", { length: 50 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: uuid("entity_id"),
    detail: text("detail"),
    beforeSnapshot: jsonb("before_snapshot"),
    afterSnapshot: jsonb("after_snapshot"),
    ipAddress: inet("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEntityIdx: index("idx_audit_logs_tenant_entity").on(
      table.tenantId,
      table.entityType,
      table.entityId,
    ),
    tenantActorIdx: index("idx_audit_logs_tenant_actor").on(table.tenantId, table.actorId),
    tenantCreatedAtIdx: index("idx_audit_logs_tenant_created").on(table.tenantId, table.createdAt),
  }),
);
