-- Convert the party (customer/supplier) default discount from a PERCENTAGE
-- (default_discount decimal) to a FIXED AMOUNT (default_discount_amount bigint),
-- matching the invoice line discount_amount convention. Unused by the current
-- API, but kept consistent so no percentage-based discount field remains.

ALTER TABLE parties RENAME COLUMN default_discount TO default_discount_amount;
ALTER TABLE parties ALTER COLUMN default_discount_amount TYPE bigint USING default_discount_amount::bigint;
ALTER TABLE parties ALTER COLUMN default_discount_amount SET DEFAULT 0;