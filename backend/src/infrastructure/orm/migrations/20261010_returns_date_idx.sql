-- OLD-PLAN Phase 2: statement window index already exists; add returns.date for profit period attribution
CREATE INDEX IF NOT EXISTS idx_returns_tenant_kind_date
  ON returns (tenant_id, kind, date)
  WHERE status = 'active';
