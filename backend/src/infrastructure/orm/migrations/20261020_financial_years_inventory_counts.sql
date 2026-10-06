-- 20261020_financial_years_inventory_counts.sql
-- Year-End Closing foundation: the year registry + the roll-level physical count.
--
-- ── What this migration deliberately does NOT do ──────────────────────────────
-- It does NOT archive, move, truncate or rewrite any existing financial row.
-- `invoices`, `invoice_lines`, `ledger_entries`, `vouchers`, `stock_movements`,
-- `returns` and `expenses` are untouched: year-end closing is a LOCK + a set of
-- SNAPSHOTS, never a deletion. A closed year must stay fully auditable.
--
-- ── Why there are no "opening" ledger rows ────────────────────────────────────
-- The ledger is RUNNING by design: `getBalance()` is SUM(debit) - SUM(credit)
-- with no date bound, `getBalanceByDate()` bounds only the upper end, and the
-- statement carries `prevByCurrency` (everything before `fromDate`) into the
-- window total. Writing an `opening` entry on Jan 1 of the new year for the
-- carried balance would therefore be counted TWICE by every one of those
-- readers — the same money once from 2026 and once from the new entry.
--
-- So the carried balance is recorded as a SNAPSHOT in `yearly_party_summaries`
-- (opening/closing per party+year+currency) for display and reporting, while the
-- ledger stays a single continuous history. `financial_years` freezes the
-- per-currency cashbox closing figures the same way, for the same reason: the
-- drawer is already continuous (`cashbox_sessions.opening_balance` +
-- cash_impact legs), and `trg_cashbox_daily_from_ledger` would apply a second
-- delta if we invented an opening cash leg.
--
-- Both tables are additive and RLS-scoped exactly like their neighbours.

CREATE TABLE IF NOT EXISTS financial_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  -- open → counting → ready → closed. Only `closed` freezes writes.
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'counting', 'ready', 'closed')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  -- Frozen at close time. NULL while the year is still open.
  closed_at timestamptz,
  closed_by uuid,
  -- Reopen trail — an audited reversal of a close, never a silent edit.
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  -- Snapshot of the drawer at the close instant, PER CURRENCY, taken from
  -- cashbox_daily_balances / recompute. Display + audit only; the drawer itself
  -- keeps rolling forward untouched (see header note).
  closing_cashbox jsonb NOT NULL DEFAULT '{}'::jsonb,
  closing_inventory_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One row per (tenant, year): the database, not the application, is what
  -- makes a double close impossible.
  CONSTRAINT financial_years_tenant_year_key UNIQUE (tenant_id, year),
  CONSTRAINT financial_years_period_ck CHECK (period_start <= period_end)
);

CREATE INDEX IF NOT EXISTS idx_financial_years_tenant_status
  ON financial_years (tenant_id, status);

ALTER TABLE financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_years FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON financial_years;
CREATE POLICY tenant_isolation ON financial_years FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── Roll-level physical count ───────────────────────────────────────────────
-- `rolls` IS the unit of stock in this schema (kg + pieces + price_per_kg), so
-- the count sheet is keyed by roll. No synthetic fabric/colour layer is
-- invented: aggregating up to fabric/colour is a UI concern over these rows.
CREATE TABLE IF NOT EXISTS inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  roll_id uuid NOT NULL REFERENCES rolls (id),
  -- Book figures are a snapshot of `rolls.remaining_kg` when the count row was
  -- opened, so a later sale cannot silently rewrite what the counter saw.
  book_kg numeric(14, 2) NOT NULL,
  book_pieces integer NOT NULL DEFAULT 0,
  counted_kg numeric(14, 2),
  counted_pieces integer,
  -- counted_* − book_*; NULL until a count is entered.
  diff_kg numeric(14, 2),
  diff_pieces integer,
  -- counted → approved → posted (posted = stock_movements 'adjustment' written).
  status varchar(20) NOT NULL DEFAULT 'counted'
    CHECK (status IN ('counted', 'approved', 'posted', 'void')),
  reason text,
  counted_by uuid,
  counted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  -- The stock_movements.id(s) written when this variance was posted, so the
  -- adjustment is traceable from the count line to the stock ledger.
  posted_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_counts_roll_year_key UNIQUE (tenant_id, year, roll_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_counts_tenant_year
  ON inventory_counts (tenant_id, year, status);

ALTER TABLE inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_counts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_counts;
CREATE POLICY tenant_isolation ON inventory_counts FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
