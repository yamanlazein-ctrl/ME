import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenant.table.js";

/**
 * Secrets — encrypted-at-rest secret store.
 *
 * Sealed by the server's `APP_MASTER_KEY` env using AES-256-GCM (see
 * 0B: `AesGcmSecretStore`). Each row stores:
 *   - key:        the lookup key (e.g. "license.signing.private",
 *                 "license.token.<activation_id>")
 *   - ciphertext: the encrypted payload, base64-encoded (so the column
 *                 can be a portable `text` rather than `bytea`; avoids
 *                 portability issues with cross-DB or cross-driver
 *                 binary columns and matches how the JwtSigner already
 *                 stores signed JWS strings).
 *   - iv:         the per-write IV, base64-encoded
 *   - authTag:    the GCM auth tag (16 bytes), base64-encoded; null
 *                 for non-GCM algos
 *   - algorithm:  always "aes-256-gcm" today; future-proofed for
 *                 algorithm migration
 *   - version:    increment on every rotation; allows optimistic locking
 *
 * The `(tenant_id, key)` UNIQUE constraint means a secret with the
 * same key in two tenants is two different rows. A NULL `tenant_id`
 * denotes a system-level secret (e.g. the master-key fingerprint).
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    key: varchar("key", { length: 128 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag"),
    algorithm: varchar("algorithm", { length: 32 }).notNull().default("aes-256-gcm"),
    version: integer("version").notNull().default(1),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantKeyIdx: uniqueIndex("idx_secrets_tenant_key").on(table.tenantId, table.key),
  }),
);
