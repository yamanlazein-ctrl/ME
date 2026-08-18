-- Convert invoice line discount from a PERCENTAGE (discount_percent) to a
-- FIXED AMOUNT (discount_amount). Discount is now a concrete currency value
-- (e.g. a 50 SYP discount on a 100 SYP line), not a percentage.
--
-- Existing percentage values are reinterpreted as fixed amounts so no data is
-- lost during the transition. The column becomes bigint (integer money) to match
-- the other monetary columns (invoices.discount, invoices.tax, invoices.shipping).

ALTER TABLE invoice_lines RENAME COLUMN discount_percent TO discount_amount;
ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE bigint USING discount_amount::bigint;
ALTER TABLE invoice_lines ALTER COLUMN discount_amount SET DEFAULT 0;
ALTER TABLE invoice_lines ALTER COLUMN discount_amount SET NOT NULL;