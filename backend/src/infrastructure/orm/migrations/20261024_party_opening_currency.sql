-- Party opening balance currency (SYP/USD), independent of the party's own
-- currency. NULL = the party's currency (every row written before this column).
ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS opening_currency varchar(3);
