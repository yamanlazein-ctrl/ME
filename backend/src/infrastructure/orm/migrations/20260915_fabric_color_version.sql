-- P0-001 parity: `fabrics` and `colors` carry the optimistic-concurrency
-- `version` column in the ORM schema (fabric.table.ts / color.table.ts) and the
-- repositories write/return it, but no migration ever added it — so on every
-- database built from the migrations, INSERT ... RETURNING version failed with
-- 42703 (`column "version" of relation "fabrics" does not exist`) and master-data
-- creation was broken (reproduced live: POST /api/inventory/fabrics -> 422).
-- Mirrors 20260913_expense_version.sql, which did the same for `expenses`.
ALTER TABLE fabrics ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE colors ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
