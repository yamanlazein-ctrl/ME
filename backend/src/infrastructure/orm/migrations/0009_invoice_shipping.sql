-- Add shipping column to invoices (الشحن) — bigint like the other monetary columns.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipping bigint NOT NULL DEFAULT 0;