-- Migration: Add pieces field to all physical item tables
-- Date: 2026-08-16

-- 1. rolls table
ALTER TABLE rolls ADD COLUMN IF NOT EXISTS pieces INTEGER NOT NULL DEFAULT 1;

-- 2. invoice_lines table
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS pieces INTEGER NOT NULL DEFAULT 1;

-- 3. order_items table
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS pieces INTEGER NOT NULL DEFAULT 1;

-- 4. return_lines table
ALTER TABLE return_lines ADD COLUMN IF NOT EXISTS pieces INTEGER NOT NULL DEFAULT 1;

-- 5. print_jobs table
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pieces INTEGER NOT NULL DEFAULT 1;

-- Update existing data: set pieces = 1 for all existing rows (backward compatible)
UPDATE rolls SET pieces = 1 WHERE pieces IS NULL;
UPDATE invoice_lines SET pieces = 1 WHERE pieces IS NULL;
UPDATE order_items SET pieces = 1 WHERE pieces IS NULL;
UPDATE return_lines SET pieces = 1 WHERE pieces IS NULL;
UPDATE print_jobs SET pieces = 1 WHERE pieces IS NULL;
