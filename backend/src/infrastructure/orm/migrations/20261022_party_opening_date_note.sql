-- Party opening balance metadata: effective date + optional note.
-- The signed amount stays on parties.opening_balance; the live balance still
-- comes from ledger SUM of active opening/opening_equity rows. These columns
-- exist so UI/sync can round-trip date and note without inventing a parallel SoT.

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS opening_date date,
  ADD COLUMN IF NOT EXISTS opening_note text;
