-- Migration: invoices.reference — the human-readable reference number
-- (فاتورة دخول ENT-2026-XXXX / فاتورة خروج INV-2026-XXXX) as a dedicated,
-- structured column instead of free text buried inside `notes`.
--
-- Backfill: every existing invoice already carries its human number in
-- `number`, so reference = number preserves history exactly. New invoices
-- default reference = server-generated number unless the user supplies one.
-- Idempotent-safe backfill (only fills NULL/empty rows).

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "reference" VARCHAR(100);

UPDATE "invoices"
SET "reference" = "number"
WHERE "reference" IS NULL OR "reference" = '';

CREATE INDEX IF NOT EXISTS "idx_invoices_reference" ON "invoices" ("tenant_id", "reference");
