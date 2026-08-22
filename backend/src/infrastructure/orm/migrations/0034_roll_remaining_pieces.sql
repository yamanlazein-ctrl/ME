-- Migration: rolls.remaining_pieces — dual-unit stock tracking [P0-LOGIC-pieces]
--
-- Stock is now tracked in BOTH kg and pieces. Until now rolls.pieces was a
-- static metadata field set at creation and never moved by any transaction,
-- while all stock movement was kg-only. This adds the live counter.
--
-- Backfill: existing rolls' pieces were never decremented by sales, so the
-- current pieces value IS the remaining count. remaining_pieces starts equal.
--
-- Idempotent.

ALTER TABLE rolls ADD COLUMN IF NOT EXISTS remaining_pieces INTEGER NOT NULL DEFAULT 0;

UPDATE rolls SET remaining_pieces = pieces WHERE remaining_pieces = 0 AND pieces > 0;
