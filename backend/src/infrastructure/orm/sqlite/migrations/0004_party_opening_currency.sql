-- Mirror of PG 20261024_party_opening_currency. NULL = the party's own currency.
ALTER TABLE "parties" ADD COLUMN "opening_currency" TEXT CONSTRAINT "ck_sqlite_len_3__parties__opening_currency" CHECK ("opening_currency" IS NULL OR length("opening_currency") <= 3);
