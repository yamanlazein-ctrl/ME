-- Mirror of PG 20261023_roll_entry_price_invoice_pieces (same columns, same backfill rules).
--
-- 1) The ACTUAL entry price of each roll, written once when the stock enters and never changed by an
--    edit of the cost price (rolls.price_per_kg). Money is a scaled integer (numeric(14,4) → × 10^4).
--    The entry DATE is the existing rolls.entry_date column; it is never modified here.
ALTER TABLE "rolls" ADD COLUMN "entry_price_per_kg" INTEGER;
ALTER TABLE "rolls" ADD COLUMN "entry_currency" TEXT CONSTRAINT "ck_sqlite_len_3__rolls__entry_currency" CHECK ("entry_currency" IS NULL OR length("entry_currency") <= 3);
ALTER TABLE "rolls" ADD COLUMN "entry_source" TEXT CONSTRAINT "ck_sqlite_len_20__rolls__entry_source" CHECK ("entry_source" IS NULL OR length("entry_source") <= 20);
ALTER TABLE "rolls" ADD COLUMN "entry_reference" TEXT CONSTRAINT "ck_sqlite_len_100__rolls__entry_reference" CHECK ("entry_reference" IS NULL OR length("entry_reference") <= 100);

-- a) purchase: the entry-invoice line that stocked the roll (earliest by date, then creation time).
--    invoice_lines.price_per_kg is numeric(12,2) (× 10^2) and entry_price_per_kg numeric(14,4) (× 10^4).
UPDATE "rolls"
   SET "entry_price_per_kg" = (SELECT il."price_per_kg" * 100 FROM "invoice_lines" il JOIN "invoices" i ON i."id" = il."invoice_id" AND i."tenant_id" = il."tenant_id"
                                WHERE il."roll_id" = "rolls"."id" AND i."type" = 'entry' ORDER BY i."date", i."created_at" LIMIT 1),
       "entry_currency"     = (SELECT i."currency" FROM "invoice_lines" il JOIN "invoices" i ON i."id" = il."invoice_id" AND i."tenant_id" = il."tenant_id"
                                WHERE il."roll_id" = "rolls"."id" AND i."type" = 'entry' ORDER BY i."date", i."created_at" LIMIT 1),
       "entry_reference"    = (SELECT i."number" FROM "invoice_lines" il JOIN "invoices" i ON i."id" = il."invoice_id" AND i."tenant_id" = il."tenant_id"
                                WHERE il."roll_id" = "rolls"."id" AND i."type" = 'entry' ORDER BY i."date", i."created_at" LIMIT 1),
       "entry_source"       = 'purchase'
 WHERE "entry_price_per_kg" IS NULL
   AND EXISTS (SELECT 1 FROM "invoice_lines" il JOIN "invoices" i ON i."id" = il."invoice_id" AND i."tenant_id" = il."tenant_id"
                WHERE il."roll_id" = "rolls"."id" AND i."type" = 'entry');

-- b) printing factory: created by a print receive, at the batch unit cost
UPDATE "rolls"
   SET "entry_price_per_kg" = "price_per_kg",
       "entry_currency"     = "currency",
       "entry_source"       = 'press',
       "entry_reference"    = (SELECT sm."reference_number" FROM "stock_movements" sm
                                WHERE sm."roll_id" = "rolls"."id" AND sm."tenant_id" = "rolls"."tenant_id" AND sm."movement_type" = 'print_receive' LIMIT 1)
 WHERE "entry_price_per_kg" IS NULL
   AND EXISTS (SELECT 1 FROM "stock_movements" sm
                WHERE sm."roll_id" = "rolls"."id" AND sm."tenant_id" = "rolls"."tenant_id" AND sm."movement_type" = 'print_receive');

-- c) direct stock-in: the roll's own price
UPDATE "rolls"
   SET "entry_price_per_kg" = "price_per_kg",
       "entry_currency"     = "currency",
       "entry_source"       = 'stock_in'
 WHERE "entry_price_per_kg" IS NULL;

-- 2) Sales invoice «عدد الأثواب»: pieces on the invoice (sum of its lines' pieces)
ALTER TABLE "invoices" ADD COLUMN "pieces_count" INTEGER;
UPDATE "invoices"
   SET "pieces_count" = COALESCE((SELECT SUM(il."pieces") FROM "invoice_lines" il WHERE il."invoice_id" = "invoices"."id"), 0)
 WHERE "pieces_count" IS NULL;
