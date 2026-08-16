-- 0020: Performance indexes + Balance Cache + Archiving tables
--
-- Goals:
-- 1. Make statement queries (كشف حساب) run in < 100ms with 50,000+ rows
-- 2. Cache party balances in O(1) instead of O(n) aggregation
-- 3. Enable yearly archiving so 5-year data doesn't slow down current-year queries
--
-- No data changes. No schema changes to existing tables (only indexes added).
-- New tables: party_balances, ledger_entry_archive, yearly_party_summaries.

-- ============================================================================
-- PART 1: Additional indexes on invoices
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON invoices (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_invoices_currency
  ON invoices (tenant_id, currency);

CREATE INDEX IF NOT EXISTS idx_invoices_type
  ON invoices (tenant_id, type);

CREATE INDEX IF NOT EXISTS idx_invoices_party_status
  ON invoices (tenant_id, party_id, status);

-- ============================================================================
-- PART 2: Additional indexes on ledger_entries (statement + balance queries)
-- ============================================================================

-- Type filter (for statement type filtering)
CREATE INDEX IF NOT EXISTS idx_ledger_type
  ON ledger_entries (tenant_id, type);

-- Currency filter (for multi-currency statement)
CREATE INDEX IF NOT EXISTS idx_ledger_currency
  ON ledger_entries (tenant_id, currency);

-- Party + Currency (for per-currency balance calculations)
CREATE INDEX IF NOT EXISTS idx_ledger_party_currency
  ON ledger_entries (tenant_id, party_id, currency);

-- Party + Date + Currency (the most important composite for statement queries)
CREATE INDEX IF NOT EXISTS idx_ledger_party_date_currency
  ON ledger_entries (tenant_id, party_id, date, currency);

-- ============================================================================
-- PART 3: Additional indexes on vouchers
-- ============================================================================

-- Date index for party balance calculations over time
CREATE INDEX IF NOT EXISTS idx_vouchers_date
  ON vouchers (tenant_id, date);

-- Party + Date (for outstanding calculations)
CREATE INDEX IF NOT EXISTS idx_vouchers_party_date
  ON vouchers (tenant_id, party_id, date);

-- ============================================================================
-- PART 4: Additional indexes on invoice_lines (inventory audit)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice
  ON invoice_lines (tenant_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_fabric
  ON invoice_lines (tenant_id, fabric_id);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_color
  ON invoice_lines (tenant_id, color_id);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_roll
  ON invoice_lines (tenant_id, roll_id);

-- ============================================================================
-- PART 5: Additional indexes on rolls (inventory audit)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_rolls_supplier
  ON rolls (tenant_id, supplier_id);

-- ============================================================================
-- PART 6: Additional indexes on audit_logs (invoice tracking)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity
  ON audit_logs (tenant_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_actor
  ON audit_logs (tenant_id, actor_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at);

-- ============================================================================
-- PART 7: Balance Cache — O(1) balance lookup per party per currency
-- ============================================================================

CREATE TABLE IF NOT EXISTS party_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP',
  balance BIGINT NOT NULL DEFAULT 0,
  last_entry_id UUID REFERENCES ledger_entries(id) ON DELETE SET NULL,
  last_entry_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, party_id, currency)
);

CREATE INDEX IF NOT EXISTS idx_party_balances_party
  ON party_balances (tenant_id, party_id);

CREATE INDEX IF NOT EXISTS idx_party_balances_currency
  ON party_balances (tenant_id, currency);

-- ============================================================================
-- PART 8: Ledger Entry Archive — cold storage for past years
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger_entry_archive (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id UUID REFERENCES parties(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  type VARCHAR(30) NOT NULL,
  debit BIGINT DEFAULT 0,
  credit BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP',
  cash_impact VARCHAR(10) NOT NULL DEFAULT 'none',
  reference_type VARCHAR(50),
  reference_id UUID,
  reference_number VARCHAR(100),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_by UUID,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancelled_by UUID,
  cancellation_reference_id UUID,
  archive_year INTEGER NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archive_tenant_party_year
  ON ledger_entry_archive (tenant_id, party_id, archive_year);

CREATE INDEX IF NOT EXISTS idx_archive_tenant_date
  ON ledger_entry_archive (tenant_id, date);

CREATE INDEX IF NOT EXISTS idx_archive_tenant_year
  ON ledger_entry_archive (tenant_id, archive_year);

-- ============================================================================
-- PART 9: Yearly Party Summary — per-year balance snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS yearly_party_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP',
  opening_balance BIGINT NOT NULL DEFAULT 0,
  closing_balance BIGINT NOT NULL DEFAULT 0,
  total_debit BIGINT NOT NULL DEFAULT 0,
  total_credit BIGINT NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  voucher_count INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, party_id, year, currency)
);

CREATE INDEX IF NOT EXISTS idx_yps_party
  ON yearly_party_summaries (tenant_id, party_id);

CREATE INDEX IF NOT EXISTS idx_yps_year
  ON yearly_party_summaries (tenant_id, year);

-- ============================================================================
-- Enable RLS on new tables (consistent with existing tables)
-- ============================================================================

ALTER TABLE party_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE yearly_party_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS tenant_isolation_party_balances
  ON party_balances FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY IF NOT EXISTS tenant_isolation_ledger_archive
  ON ledger_entry_archive FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY IF NOT EXISTS tenant_isolation_yearly_summary
  ON yearly_party_summaries FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================================
-- COMMENTS (self-documenting)
-- ============================================================================

COMMENT ON TABLE party_balances IS 'Materialized balance cache per party per currency. Updated atomically in the same transaction as ledger entries. NEVER inconsistent with ledger_entries.';
COMMENT ON TABLE ledger_entry_archive IS 'Cold storage for ledger entries older than the current year. Moved here by archive process at year-end or on-demand.';
COMMENT ON TABLE yearly_party_summaries IS 'Per-year per-party balance snapshots. Makes multi-year reports O(years) instead of O(rows).';
