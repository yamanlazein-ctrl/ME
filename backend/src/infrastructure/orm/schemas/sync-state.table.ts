import {
  pgTable,
  uuid,
  timestamp,
  bigint,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/** Per-tenant sync cursors (pull watermark). */
export const syncState = pgTable("sync_state", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  /** Display-only watermark. Never used for pagination — see lastPullSeq. */
  lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
  /**
   * The pull cursor: highest `sync_inbox.received_seq` already materialized.
   * A monotonic sequence, so no operation can be skipped by a timestamp tie.
   */
  lastPullSeq: bigint("last_pull_seq", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
