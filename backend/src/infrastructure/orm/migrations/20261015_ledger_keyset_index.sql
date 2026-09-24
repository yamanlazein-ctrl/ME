-- Keyset paging of the ledger list ("load all" callers) seeks on
-- (created_at, id) DESC per tenant. Without this index every 1000-row page
-- was a parallel seq scan + top-N sort of the whole table (~116 ms at 500k
-- entries); with it a page is a short backward index range scan.
CREATE INDEX IF NOT EXISTS idx_ledger_keyset ON ledger_entries (tenant_id, created_at DESC, id DESC);
