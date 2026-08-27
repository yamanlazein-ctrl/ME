-- 0041: Server-side party-list aggregation indexes.
--
-- Supports PostgresPartyRepository.computeListStats — the two GROUP BY queries
-- that power the قائمة العملاء/الموردين summary (invoice count, total, paid and
-- the authoritative ledger balance) without shipping the tenant's invoices and
-- vouchers to the client:
--
--   invoices       → WHERE (tenant_id, party_id, type, status, currency) GROUP BY party_id
--   vouchers       → WHERE (tenant_id, party_id, kind, status, currency) GROUP BY party_id
--   ledger_entries → WHERE (tenant_id, party_id, status, currency)      GROUP BY party_id
--
-- Each composite index mirrors the GROUP BY filter order so the planner can scan
-- an index range per party instead of the whole tenant table (keeps list renders
-- O(parties), independent of how many invoices/vouchers/ledger rows exist).

CREATE INDEX IF NOT EXISTS idx_invoices_party_type_status_currency
  ON invoices (tenant_id, party_id, type, status, currency);

CREATE INDEX IF NOT EXISTS idx_vouchers_party_kind_status_currency
  ON vouchers (tenant_id, party_id, kind, status, currency);

CREATE INDEX IF NOT EXISTS idx_ledger_party_status_currency
  ON ledger_entries (tenant_id, party_id, status, currency);

COMMENT ON INDEX idx_invoices_party_type_status_currency IS 'Party list aggregation: invoices GROUP BY party_id scoped to type/status/currency.';
COMMENT ON INDEX idx_vouchers_party_kind_status_currency IS 'Party list aggregation: vouchers GROUP BY party_id scoped to kind/status/currency.';
COMMENT ON INDEX idx_ledger_party_status_currency IS 'Party list aggregation: authoritative ledger balance GROUP BY party_id scoped to status/currency.';