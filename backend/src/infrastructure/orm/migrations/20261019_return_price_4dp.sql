-- Audit F-004: a linked return is valued at the quantity-weighted price of
-- the invoice lines it reverses (10 kg @5 + 1 kg @9 → 5.3636/kg). At 2
-- decimals that became 5.36 and a FULL return credited 58.96 instead of the
-- 59.00 actually invoiced. 4 decimals makes a full return restore exactly the
-- invoiced value (each line is still rounded to cents when summed/posted).
ALTER TABLE return_lines ALTER COLUMN price_per_kg TYPE numeric(14, 4);
