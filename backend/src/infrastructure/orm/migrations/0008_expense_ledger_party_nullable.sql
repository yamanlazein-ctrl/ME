-- F1: allow no-party ledger rows (expenses are not tied to a customer/supplier).
ALTER TABLE ledger_entries ALTER COLUMN party_id DROP NOT NULL;