-- Expand discount_percent to support real discount percentages (up to 2 decimal places)
ALTER TABLE invoice_lines ALTER COLUMN discount_percent TYPE numeric(6,2);
