-- DFP-014: normalize sync device↔user authorization into a relational join
-- so authorized users must exist, belong to the same tenant, and cascade on
-- user/device deletion. The uuid[] column remains a denormalized cache rebuilt
-- from this table by the repository.

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_uidx
  ON users (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS sync_devices_tenant_id_uidx
  ON sync_devices (tenant_id, id);

CREATE TABLE IF NOT EXISTS sync_device_authorized_users (
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id),
  CONSTRAINT sync_device_authorized_users_device_fk
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES sync_devices (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT sync_device_authorized_users_user_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_device_auth_users_user
  ON sync_device_authorized_users (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_sync_device_auth_users_device
  ON sync_device_authorized_users (tenant_id, device_id);

ALTER TABLE sync_device_authorized_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_device_authorized_users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_device_authorized_users_tenant_isolation ON sync_device_authorized_users;
DROP POLICY IF EXISTS tenant_isolation ON sync_device_authorized_users;
CREATE POLICY tenant_isolation ON sync_device_authorized_users FOR ALL
USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Backfill from legacy array (ignore IDs that are not same-tenant users).
INSERT INTO sync_device_authorized_users (device_id, user_id, tenant_id)
SELECT d.id, u.id, d.tenant_id
FROM sync_devices AS d
CROSS JOIN LATERAL unnest(d.authorized_user_ids) AS uid(user_id)
JOIN users AS u ON u.id = uid.user_id AND u.tenant_id = d.tenant_id
ON CONFLICT DO NOTHING;

-- Drop cross-tenant / deleted / wrong-tenant entries from the denormalized array.
UPDATE sync_devices AS d
SET authorized_user_ids = COALESCE(
  (
    SELECT array_agg(a.user_id ORDER BY a.created_at)
    FROM sync_device_authorized_users AS a
    WHERE a.device_id = d.id AND a.tenant_id = d.tenant_id
  ),
  '{}'::uuid[]
);
