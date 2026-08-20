-- Migration: add unique constraint on return_lines (return_id, roll_id)
-- Prevents duplicate rollId lines in a single return request (fix 3.2b)
-- Idempotent: uses CREATE UNIQUE INDEX IF NOT EXISTS
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_lines_return_roll ON return_lines (return_id, roll_id);
