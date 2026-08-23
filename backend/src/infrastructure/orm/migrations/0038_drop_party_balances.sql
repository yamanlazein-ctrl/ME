-- 0038_drop_party_balances
-- M7 cleanup: party_balances was a materialized balance cache that was never
-- written to and never read from anywhere in the codebase — pure dead schema.
-- The ledger itself (ledger_entries, status = 'active') is the single source
-- of truth for every balance computation (statement, cashbox, dashboards).
-- The Drizzle schema file has been removed; this drops the orphaned table.
-- Idempotent: safe on databases where it was never created.
DROP INDEX IF EXISTS idx_party_balances_party;
DROP INDEX IF EXISTS idx_party_balances_currency;
DROP TABLE IF EXISTS party_balances CASCADE;
