import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  text,
  jsonb,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Setup wizard state — one row per tenant, tracking the Initial Setup
 * Wizard's progress so the user can resume.
 *
 * The PK is `tenantId` (1:1 with tenants). Created with the tenant
 * on first activation, updated on each wizard step save.
 *
 * The frontend `InstallGate` checks `isCompleted` to decide whether
 * to render the wizard or let the user through. The backend's
 * `install.gate.middleware` (sub-batch 0F) checks the same column
 * to block every route except `/api/setup/*` and `/api/health/*`.
 *
 * Steps are referenced by name (free-form) so the wizard can grow
 * without a migration. The canonical names are:
 *   "welcome" | "activate" | "company" | "localization" | "admin" | "review"
 */
export const setupWizardState = pgTable("setup_wizard_state", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  currentStep: varchar("current_step", { length: 50 }).notNull().default("welcome"),
  completedSteps: text("completed_steps").array().notNull().default([]),
  isCompleted: boolean("is_completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Partial answers the user has typed so far — used to resume a
  // half-completed wizard. Cleared on `is_completed = true`.
  data: jsonb("data").default("{}"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
