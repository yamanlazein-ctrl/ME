-- Search uses ILIKE '%term%' (contains). A b-tree cannot serve a leading
-- wildcard, so at 100k+ rows every search was a sequential scan. Trigram GIN
-- indexes make contains-search index-backed. pg_trgm is a trusted extension
-- (PG13+) and ships with the bundled PostgreSQL (lib/pg_trgm.dll).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_reference_trgm ON invoices USING gin (reference gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_parties_name_trgm ON parties USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_parties_code_trgm ON parties USING gin (code gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rolls_roll_no_trgm ON rolls USING gin (roll_no gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fabrics_name_trgm ON fabrics USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_colors_name_trgm ON colors USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vouchers_number_trgm ON vouchers USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_returns_number_trgm ON returns USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expenses_number_trgm ON expenses USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_expenses_description_trgm ON expenses USING gin (description gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_orders_code_trgm ON orders USING gin (code gin_trgm_ops);
