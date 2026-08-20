-- Migration: journal negative opening balances that were stored but never journaled (P0-LOGIC-3.6f)
-- Before fix, only openingBalance >0 was journaled. This inserts ledger entries for parties where
-- opening_balance <0 and no opening ledger entry exists.
-- Idempotent: only inserts where no opening entry exists.

INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, debit, credit, currency, cash_impact, reference_type, reference_id, reference_number, description, status, created_at)
SELECT gen_random_uuid(), p.tenant_id, p.id, CURRENT_DATE, 'opening', 0, ABS(p.opening_balance), p.currency, 'none', 'opening', p.id, p.code, 'الرصيد الافتتاحي (إصلاح سالب)', 'active', NOW()
FROM parties p
WHERE p.opening_balance < 0
AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.party_id = p.id AND le.type = 'opening' AND le.status = 'active');

INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, debit, credit, currency, cash_impact, reference_type, reference_id, reference_number, description, status, created_at)
SELECT gen_random_uuid(), p.tenant_id, NULL, CURRENT_DATE, 'opening_equity', ABS(p.opening_balance), 0, p.currency, 'none', 'opening', p.id, p.code, 'رأس مال (مقابل رصيد افتتاحي سالب)', 'active', NOW()
FROM parties p
WHERE p.opening_balance < 0
AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.type = 'opening_equity' AND le.reference_id = p.id AND le.status = 'active');
