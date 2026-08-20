import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  bigint,
  date,
  text,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";
import { parties } from "./party.table.js";
import { invoices } from "./invoice.table.js";

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: varchar("kind", { length: 10 }).notNull(),
    number: varchar("number", { length: 50 }).notNull(),
    date: date("date").notNull(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id),
    partyKind: varchar("party_kind", { length: 10 }).notNull(),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SYP"),
    method: varchar("method", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    notesPrint: text("notes_print"),
    notesInternal: text("notes_internal"),
    attachments: jsonb("attachments").default("[]"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
  },
  (table) => ({
    tenantKindNumberIdx: uniqueIndex("idx_vouchers_tenant_kind_number").on(
      table.tenantId,
      table.kind,
      table.number,
    ),
    partyIdx: index("idx_vouchers_party").on(table.tenantId, table.partyId),
    invoiceIdx: index("idx_vouchers_invoice").on(table.tenantId, table.invoiceId),
  }),
);
