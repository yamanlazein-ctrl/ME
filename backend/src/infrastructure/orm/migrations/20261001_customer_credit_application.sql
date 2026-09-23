-- Customer advance payments / overpayment → credit balance.
--
-- vouchers.applied_amount: the part of a receipt that actually settled its linked
--   invoice, in the INVOICE's currency. A receipt larger than the invoice's
--   remaining balance settles the invoice in full and the excess stays on the
--   customer's ledger as credit (the party leg is always posted in full). Cancel
--   reverses exactly this amount from invoices.paid. NULL = legacy row (cancel
--   falls back to the posted party leg, the pre-existing behaviour).
--
-- invoices.credit_applied: the part of invoices.paid funded from the customer's
--   existing credit balance at creation time. It moves NO ledger entry — the
--   ledger is already net (invoice Dr + earlier receipt Cr); it only marks the
--   invoice as settled so open-invoice lists, aging and the statement agree
--   with the ledger balance.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS applied_amount numeric(14, 2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credit_applied numeric(14, 2) NOT NULL DEFAULT 0;
