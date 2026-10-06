/**
 * SQLite-only runtime tables (specs/001-desktop-sqlite-engine data-model.md §3, task T035).
 * Hand-written; not generated (they have no PostgreSQL counterpart).
 */
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { uuid, timestamptz, textArray, jsonb, boolean, nowDefault } from "../types.js";

/** Identity of this company database file. Exactly one row (`id = 1`). */
export const motardMeta = sqliteTable("motard_meta", {
  id: integer("id", { mode: "number" }).primaryKey().default(1),
  /** Minted once at creation. Never changes. Copied unchanged into backups. */
  dataId: uuid("data_id").notNull(),
  /** Device-binding id that created the file; compared at open (R11). */
  createdByInstallationId: text("created_by_installation_id").notNull(),
  /** Installations explicitly allowed to open it: appended only on "Open existing" or a restore. */
  adoptedInstallationIds: textArray("adopted_installation_ids").notNull().default([]),
  /**
   * GUID of the install (HKCU marker) that last opened it (D-1). Updated only by a
   * verified update hand-off or an explicit "Open existing".
   */
  installInstanceId: text("install_instance_id"),
  /** The single company in this file (ID-7). */
  tenantId: uuid("tenant_id"),
  /** SQLite migration level; newer than the binary supports → refuse to open. */
  schemaJournalIdx: integer("schema_journal_idx", { mode: "number" }).notNull(),
  /** Diagnostics: last app version that opened the file. */
  appVersionLastOpened: text("app_version_last_opened"),
  createdAt: timestamptz("created_at").notNull().$defaultFn(nowDefault),
  /** Backup `data_id` + manifest hash when this file came from a restore (drives SY-6). */
  restoredFrom: jsonb("restored_from").$type<{ dataId: string; manifestSha256: string } | null>(),
});

/** Replaces PostgreSQL sequences (`nextval`); incremented inside the writing transaction. */
export const motardSequences = sqliteTable("motard_sequences", {
  name: text("name").primaryKey(),
  value: integer("value", { mode: "number" }).notNull(),
});

/**
 * Transaction clock + session flags read by the triggers (one row, `id = 1`). The writer stamps
 * `ts` at BEGIN and resets both flags before COMMIT (T042); PG equivalents are `now()` and the
 * `app.allow_party_remap` / dye-purge settings. A table (not app functions or a TEMP table) because
 * the schema must work under `trusted_schema=OFF` and main-schema triggers cannot see TEMP tables.
 */
export const motardTxState = sqliteTable("motard_tx_state", {
  id: integer("id", { mode: "number" }).primaryKey().default(1),
  ts: text("ts"),
  allowPartyRemap: boolean("allow_party_remap").notNull().default(false),
  allowDyePurge: boolean("allow_dye_purge").notNull().default(false),
});
