-- batch1_tombstones_and_conflicts.sql
-- Batch 1: tombstone/delete propagation + rejected update/cancel conflict tracking

-- ============================================================
-- sync_tombstones: deleted entities that must not resurrect
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  op_id uuid NOT NULL,
  deleted_by_device_id uuid REFERENCES sync_devices(id),
  -- version at deletion time for causality check
  deleted_entity_version integer NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_tenant ON sync_tombstones(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sync_tombstones_entity ON sync_tombstones(tenant_id, entity_type, entity_id);

ALTER TABLE sync_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_tombstones FORCE ROW LEVEL SECURITY;

-- Canonical guarded cast (enable-rls.sql §1): set_config(..., NULL) stores ''
-- rather than NULL, and ''::uuid raises 22P02 — which made the tombstone
-- lookup error out and silently skip the resurrection guard. Existing
-- databases already applied the unguarded form and are repaired by
-- 20260914_sync_rls_canonical_policies (same policy, idempotent).
DROP POLICY IF EXISTS sync_tombstones_tenant_isolation ON sync_tombstones;
DROP POLICY IF EXISTS tenant_isolation ON sync_tombstones;
CREATE POLICY tenant_isolation ON sync_tombstones
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- sync_conflicts: rejected update/cancel reconciliation state
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  op_id uuid NOT NULL,
  entity_type varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  operation varchar(20) NOT NULL, -- 'update' | 'cancel'
  base_version integer NOT NULL,
  server_version integer NOT NULL,
  local_intent jsonb NOT NULL, -- full payload snapshot
  status varchar(20) NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution jsonb, -- how it was resolved
  UNIQUE(tenant_id, op_id)
);

CREATE INDEX idx_sync_conflicts_tenant ON sync_conflicts(tenant_id);
CREATE INDEX idx_sync_conflicts_entity ON sync_conflicts(tenant_id, entity_type, entity_id);
CREATE INDEX idx_sync_conflicts_open ON sync_conflicts(tenant_id) WHERE status = 'open';

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_conflicts_tenant_isolation ON sync_conflicts;
DROP POLICY IF EXISTS tenant_isolation ON sync_conflicts;
CREATE POLICY tenant_isolation ON sync_conflicts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);