-- Migration: snapshot costPerKg on invoice_lines for COGS accuracy (P0-LOGIC-3.6c)
-- Sale returns currently debit inventory at sale price and never reverse cogs_expense,
-- overstating inventory and profit by (sale_price - cost) per kg. This adds a
-- cost snapshot so returns can be valued at cost and COGS can be journaled from
-- the snapshot, not a live join to rolls.pricePerKg (which is mutable).
-- Idempotent.

ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS cost_per_kg DECIMAL(12,2);
-- Backfill existing sale lines with current roll price as best-effort cost (may be stale, but better than null)
UPDATE invoice_lines il
SET cost_per_kg = r.price_per_kg
FROM rolls r
WHERE il.roll_id = r.id AND il.cost_per_kg IS NULL;
