import { pgTable, bigserial, uuid, varchar, integer, jsonb, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Durable idempotency-key store (migration 0014). Redis is the primary
 * cache (5-min TTL); this table is the fallback/durable record so a
 * retried POST with the same Idempotency-Key never double-applies, even
 * across restarts, replicas, or when Redis is unavailable.
 *
 * Fix C-6 (forensic audit 2026-08-15): this table existed only as a raw
 * migration file with no Drizzle schema binding, so `db:push` — the only
 * build path that actually works in this project (see docs/decisions.md
 * D-001; `db:migrate` fails on 0001's invalid `CREATE POLICY IF NOT
 * EXISTS` syntax) — never created it. The fallback idempotency code
 * (idempotency.middleware.ts) was written against this table but it did
 * not exist in any db:push-built database, silently falling back further
 * to a per-process in-memory Map instead. Adding this schema definition
 * is what makes `db:push` actually create the table, closing that gap.
 *
 * The FK to tenants (absent from the original migration — a separate,
 * pre-existing orphan-risk gap) is added here since this is a fresh
 * schema definition anyway.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    method: varchar("method", { length: 10 }).notNull(),
    path: text("path").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body"),
    contentType: varchar("content_type", { length: 100 }).notNull().default("application/json; charset=utf-8"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    scopeIdx: uniqueIndex("uq_idempotency_scope").on(
      table.tenantId,
      table.method,
      table.path,
      table.idempotencyKey,
    ),
    expiresIdx: index("idx_idempotency_expires").on(table.expiresAt),
  }),
);
