-- Make day_closes unique per (tenant_id, date, currency) so multi-currency
-- day closes never collide and per-currency writes are never falsely rejected
-- M-02 / F-5: per-currency day-close granularity
DROP INDEX IF EXISTS idx_day_closes_tenant_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_day_closes_tenant_date_currency
  ON day_closes (tenant_id, date, currency);
