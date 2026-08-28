-- Phase ب — customer directory columns on `licenses`.
-- Additive only: three nullable text columns. No data is altered or dropped.
ALTER TABLE "licenses" ADD COLUMN "customer_name" text;
ALTER TABLE "licenses" ADD COLUMN "customer_phone" text;
ALTER TABLE "licenses" ADD COLUMN "customer_notes" text;
