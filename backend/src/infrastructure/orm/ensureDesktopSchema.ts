import { logger } from "../config/logger.js";

const TENANT_POLICY = `
USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
`;

async function forceTenantRls(
  query: (sql: string) => Promise<unknown>,
  table: string,
): Promise<void> {
  await query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table}`);
  await query(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
  await query(`CREATE POLICY tenant_isolation ON ${table} FOR ALL ${TENANT_POLICY}`);
}

/**
 * Idempotent desktop schema patches for baked pgdata templates that shipped
 * older than the current drizzle journal. Drizzle migrations
 * (`backend/src/infrastructure/orm/migrations` + `_journal.json`) are the
 * source of truth. This file must only ADD COLUMN / CREATE IF NOT EXISTS
 * objects that already exist in those migrations — never a parallel schema.
 */
export async function ensureDesktopSchema(query: (sql: string) => Promise<unknown>): Promise<void> {
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash varchar(255)`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_revoked_before timestamptz`);

  await query(`
    CREATE TABLE IF NOT EXISTS sync_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      last_seen_by_user_id uuid REFERENCES users(id),
      authorized_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
      revoked_at timestamptz,
      revoke_reason varchar(64),
      device_fingerprint varchar(128) NOT NULL,
      device_fingerprint_version integer DEFAULT 1 NOT NULL,
      platform varchar(16) NOT NULL,
      hostname varchar(120),
      label varchar(120),
      last_seen_at timestamptz DEFAULT now() NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL
    )
  `);
  await query(
    `ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS authorized_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]`,
  );
  await query(`ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS revoked_at timestamptz`);
  await query(`ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS revoke_reason varchar(64)`);
  await query(`
    UPDATE sync_devices SET authorized_user_ids = ARRAY[last_seen_by_user_id]
      WHERE last_seen_by_user_id IS NOT NULL AND authorized_user_ids = '{}'::uuid[]
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_devices_tenant_fingerprint ON sync_devices (tenant_id, device_fingerprint)`,
  );
  await forceTenantRls(query, "sync_devices");

  // DFP-014 — relational device↔user authorization (SoT for authorized_user_ids cache).
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_uidx ON users (tenant_id, id)`);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS sync_devices_tenant_id_uidx ON sync_devices (tenant_id, id)`,
  );
  await query(`
    CREATE TABLE IF NOT EXISTS sync_device_authorized_users (
      device_id uuid NOT NULL,
      user_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (device_id, user_id)
    )
  `);
  await query(`
    DO $$ BEGIN
      ALTER TABLE sync_device_authorized_users
        ADD CONSTRAINT sync_device_authorized_users_device_fk
        FOREIGN KEY (tenant_id, device_id) REFERENCES sync_devices (tenant_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await query(`
    DO $$ BEGIN
      ALTER TABLE sync_device_authorized_users
        ADD CONSTRAINT sync_device_authorized_users_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_sync_device_auth_users_user ON sync_device_authorized_users (tenant_id, user_id)`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_sync_device_auth_users_device ON sync_device_authorized_users (tenant_id, device_id)`,
  );
  await forceTenantRls(query, "sync_device_authorized_users");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      sync_device_id uuid REFERENCES sync_devices(id),
      op_id uuid NOT NULL,
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      operation varchar(20) NOT NULL,
      payload jsonb NOT NULL,
      status varchar(20) DEFAULT 'pending' NOT NULL,
      error_detail text,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      synced_at timestamptz
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_outbox_tenant_op ON sync_outbox (tenant_id, op_id)`,
  );
  await query(`ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS seq bigserial`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_sync_outbox_tenant_status_seq ON sync_outbox (tenant_id, status, seq)`,
  );
  await forceTenantRls(query, "sync_outbox");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_inbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      sync_device_id uuid REFERENCES sync_devices(id),
      op_id uuid NOT NULL,
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      operation varchar(20) NOT NULL,
      payload jsonb NOT NULL,
      status varchar(20) DEFAULT 'received' NOT NULL,
      received_at timestamptz DEFAULT now() NOT NULL,
      applied_at timestamptz
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_inbox_tenant_op ON sync_inbox (tenant_id, op_id)`,
  );
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS reject_reason text`);
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS conflict_op_id uuid`);
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS conflict_detail jsonb`);
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS received_seq bigserial`);
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS materialize_error jsonb`);
  await query(
    `ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS apply_attempts integer DEFAULT 0 NOT NULL`,
  );
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz`);
  await query(`ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS tombstone_id uuid`);
  await query(
    `CREATE INDEX IF NOT EXISTS idx_sync_inbox_tenant_status_received_seq ON sync_inbox (tenant_id, status, received_seq)`,
  );
  await forceTenantRls(query, "sync_inbox");

  await query(`
    CREATE TABLE IF NOT EXISTS document_number_blocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      sync_device_id uuid NOT NULL REFERENCES sync_devices(id),
      entity_type varchar(30) NOT NULL,
      year integer NOT NULL,
      prefix varchar(10) NOT NULL,
      start_number bigint NOT NULL,
      end_number bigint NOT NULL,
      next_number bigint NOT NULL,
      status varchar(20) DEFAULT 'active' NOT NULL,
      claimed_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      reclaimed_at timestamptz
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_num_blocks_tenant_entity_year_start ON document_number_blocks (tenant_id, entity_type, year, start_number)`,
  );
  await forceTenantRls(query, "document_number_blocks");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_resource_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      resource_type varchar(40) NOT NULL,
      resource_id uuid NOT NULL,
      claimed_by_op_id uuid NOT NULL,
      claimed_by_device_id uuid REFERENCES sync_devices(id),
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      claimed_at timestamptz DEFAULT now() NOT NULL
    )
  `);
  await query(
    `ALTER TABLE sync_resource_claims ADD COLUMN IF NOT EXISTS quantity_kg numeric(14, 3)`,
  );
  await query(`ALTER TABLE sync_resource_claims ADD COLUMN IF NOT EXISTS quantity_pieces integer`);
  await query(
    `ALTER TABLE sync_resource_claims DROP CONSTRAINT IF EXISTS uq_sync_resource_claims_tenant_resource`,
  );
  await query(`DROP INDEX IF EXISTS uq_sync_resource_claims_tenant_resource`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_claims_identity
      ON sync_resource_claims (tenant_id, resource_type, resource_id)
      WHERE quantity_kg IS NULL AND quantity_pieces IS NULL
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_claims_qty_op
      ON sync_resource_claims (tenant_id, resource_type, resource_id, claimed_by_op_id)
      WHERE quantity_kg IS NOT NULL OR quantity_pieces IS NOT NULL
  `);
  await forceTenantRls(query, "sync_resource_claims");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
      last_pull_at timestamptz,
      updated_at timestamptz DEFAULT now() NOT NULL
    )
  `);
  await query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_pull_seq bigint`);
  await forceTenantRls(query, "sync_state");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      deleted_by_device_id uuid REFERENCES sync_devices(id),
      op_id uuid NOT NULL,
      deletion_seq bigint,
      deleted_at timestamptz DEFAULT now() NOT NULL,
      deleted_entity_version integer NOT NULL DEFAULT 1,
      created_at timestamptz DEFAULT now() NOT NULL
    )
  `);
  await query(`ALTER TABLE sync_tombstones ADD COLUMN IF NOT EXISTS deletion_seq bigint`);
  await query(
    `ALTER TABLE sync_tombstones ADD COLUMN IF NOT EXISTS deleted_entity_version integer NOT NULL DEFAULT 1`,
  );
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_tombstones_tenant_entity ON sync_tombstones (tenant_id, entity_type, entity_id)`,
  );
  await forceTenantRls(query, "sync_tombstones");

  await query(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      op_id uuid NOT NULL,
      entity_type varchar(40) NOT NULL,
      entity_id uuid NOT NULL,
      operation varchar(20) NOT NULL,
      base_version integer NOT NULL DEFAULT 1,
      server_version integer NOT NULL DEFAULT 1,
      local_intent jsonb NOT NULL DEFAULT '{}'::jsonb,
      status varchar(20) NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      resolution jsonb
    )
  `);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_conflicts_tenant_op ON sync_conflicts (tenant_id, op_id)`,
  );
  await forceTenantRls(query, "sync_conflicts");

  await query(
    `ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount numeric(14, 2) NOT NULL DEFAULT 0`,
  );

  logger.info(
    "Desktop schema ensure: sync protocol columns + quantity claims + tombstones + RLS ready",
  );
}
