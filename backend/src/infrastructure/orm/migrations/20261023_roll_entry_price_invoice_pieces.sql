-- 1) The ACTUAL entry price of each roll (exact item: fabric + color/dye + roll), kept forever.
--    rolls.price_per_kg is the editable cost price (inventory edit field), so it cannot serve as the
--    historical entry price. These columns are written once when the stock enters — purchase
--    (entry) invoice line, printing-factory receive, or a direct stock-in — and never updated by an
--    edit. The sales screen shows them next to the sale price as a reference (never a default).
ALTER TABLE rolls
  ADD COLUMN IF NOT EXISTS entry_price_per_kg numeric(14, 4),
  ADD COLUMN IF NOT EXISTS entry_currency varchar(3),
  ADD COLUMN IF NOT EXISTS entry_source varchar(20),
  ADD COLUMN IF NOT EXISTS entry_reference varchar(100);
-- (the entry DATE is the existing rolls.entry_date column; it is never modified here)
--> statement-breakpoint
-- Backfill, most reliable evidence first:
--   a) purchase: the entry-invoice line that stocked the roll (an entry invoice may only stock a
--      fresh, empty roll, so there is one) — its price, the invoice currency and number;
UPDATE rolls r
   SET entry_price_per_kg = src.price_per_kg,
       entry_currency     = src.currency,
       entry_source       = 'purchase',
       entry_reference    = src.number
  FROM (
    SELECT DISTINCT ON (il.roll_id) il.roll_id, il.price_per_kg, i.currency, i.number
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id AND i.tenant_id = il.tenant_id
     WHERE i.type = 'entry'
     ORDER BY il.roll_id, i.date, i.created_at
  ) src
 WHERE r.id = src.roll_id AND r.entry_price_per_kg IS NULL;
--> statement-breakpoint
--   b) printing factory: the roll was created by a print receive, at the batch unit cost;
UPDATE rolls r
   SET entry_price_per_kg = r.price_per_kg,
       entry_currency     = r.currency,
       entry_source       = 'press',
       entry_reference    = sm.reference_number
  FROM stock_movements sm
 WHERE sm.roll_id = r.id AND sm.tenant_id = r.tenant_id AND sm.movement_type = 'print_receive'
   AND r.entry_price_per_kg IS NULL;
--> statement-breakpoint
--   c) direct stock-in: the roll's own price (the best record that exists for rows created before
--      this migration).
UPDATE rolls
   SET entry_price_per_kg = price_per_kg,
       entry_currency     = currency,
       entry_source       = 'stock_in'
 WHERE entry_price_per_kg IS NULL;
--> statement-breakpoint
-- 2) Sales invoice "عدد الأثواب": the number of pieces on the invoice, stored on the invoice itself
--    (= sum of its lines' pieces, computed by the server when the invoice is saved).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS pieces_count integer;
--> statement-breakpoint
UPDATE invoices i
   SET pieces_count = COALESCE((SELECT SUM(il.pieces) FROM invoice_lines il WHERE il.invoice_id = i.id), 0)
 WHERE i.pieces_count IS NULL;
