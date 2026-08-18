-- 0018: Party statement (كشف حساب) query index.
--
-- The statement reads all ledger rows for one party inside a date window,
-- ordered by (date, created_at) to accumulate running balances:
--
--   WHERE tenant_id = ? AND party_id = ? AND currency = ? AND date >= ? ...
--   ORDER BY date ASC, created_at ASC
--
-- idx_ledger_party (tenant_id, party_id) narrows by party but still requires a
-- sort for the ORDER BY. This composite index covers party + date so the range
-- scan is index-ordered and the running-balance window doesn't need a full sort.
CREATE INDEX IF NOT EXISTS idx_ledger_party_date
  ON ledger_entries (tenant_id, party_id, date, created_at);
