-- Unit COST prices carry 4 decimals.
--
-- A received print batch is costed as (raw cost of everything sent + press
-- charges) / net kilos received, so the lost weight is absorbed into the
-- sellable fabric. That division is rarely exact: at 2 decimals every batch
-- lost up to half a cent per kilo, and the per-sale cost snapshot rounded it
-- again. 4 decimals keeps inventory value and cost of goods sold within a
-- fraction of a cent of the real batch cost. Widening only (no data change):
-- integer digits stay 10.
ALTER TABLE rolls ALTER COLUMN price_per_kg TYPE numeric(14, 4);
--> statement-breakpoint
ALTER TABLE invoice_lines ALTER COLUMN cost_per_kg TYPE numeric(14, 4);
