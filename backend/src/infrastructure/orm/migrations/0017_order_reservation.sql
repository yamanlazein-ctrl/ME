-- 0017: Order reservation — pin order items to specific rolls (multi-roll) and
-- mark the roll as reserved so stock can't be double-sold while an open order
-- exists. Cancelling the order (or fulfilling it) releases the reservation.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS roll_id uuid REFERENCES rolls(id);

CREATE INDEX IF NOT EXISTS idx_order_items_roll ON order_items (tenant_id, roll_id);
