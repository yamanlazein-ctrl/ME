-- 0012: Party balance sign convention — ledger entries for a party account.
-- Invoices DEBIT the party (sale invoice debits customer / entry invoice debits
-- supplier); receipts, payments and returns CREDIT the party.
-- Before this migration the following types were written with the opposite side
-- (sale invoices as credit, payments as debit, sale returns as debit). Flip them
-- so historical data matches the new writers (PostgresInvoiceRepository /
-- PostgresVoucherRepository / PostgresReturnRepository).
-- Cancelled rows are flipped too so history stays consistent (they are excluded
-- from balances anyway).
UPDATE ledger_entries
SET debit = credit, credit = debit
WHERE type IN ('sales_invoice', 'payment_out', 'sales_return');
