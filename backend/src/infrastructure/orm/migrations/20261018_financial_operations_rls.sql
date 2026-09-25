-- Audit F-008: financial_operations (durable responses of financial
-- requests, one row per company) was created after the blanket FORCE-RLS
-- migration (20260923) and never received row-level security, unlike every
-- other tenant table. Same policy family as idempotency_keys (0029), with an
-- explicit WITH CHECK so a write can only land in the caller's company.
-- The idempotency middleware writes through the TenantScopedPool, which stamps
-- app.current_tenant_id on every checkout; backup/restore set it per session.
ALTER TABLE financial_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE financial_operations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON financial_operations;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON financial_operations FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
