-- OLD-PLAN Phase 0.2: freeze legacy COGS — backfill null invoice_lines.cost_per_kg
-- Prefer proportional share of posted cogs_expense ledger; else snapshot rolls.price_per_kg once.
-- After this migration, profit reports must not re-read live roll prices for historical lines.

UPDATE invoice_lines il
SET cost_per_kg = sub.unit_cost
FROM (
  SELECT
    il2.id AS line_id,
    ROUND(
      (
        COALESCE(cogs.posted_cogs, 0)::numeric
        * (il2.quantity_kg::numeric * COALESCE(il2.price_per_kg, 0)::numeric)
        / NULLIF(inv_tot.line_amount_sum, 0)
      )
      / NULLIF(il2.quantity_kg::numeric, 0)
    , 2) AS unit_cost
  FROM invoice_lines il2
  INNER JOIN invoices inv ON inv.id = il2.invoice_id AND inv.tenant_id = il2.tenant_id
  INNER JOIN LATERAL (
    SELECT COALESCE(SUM(il3.quantity_kg::numeric * COALESCE(il3.price_per_kg, 0)::numeric), 0) AS line_amount_sum
    FROM invoice_lines il3
    WHERE il3.invoice_id = il2.invoice_id AND il3.tenant_id = il2.tenant_id
  ) inv_tot ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(le.debit - le.credit), 0) AS posted_cogs
    FROM ledger_entries le
    WHERE le.tenant_id = inv.tenant_id
      AND le.status = 'active'
      AND le.type = 'cogs_expense'
      AND le.reference_type = 'sales_invoice'
      AND le.reference_id = inv.id
  ) cogs ON true
  WHERE il2.cost_per_kg IS NULL
    AND inv.type = 'sale'
    AND COALESCE(cogs.posted_cogs, 0) > 0
    AND il2.quantity_kg::numeric > 0
    AND inv_tot.line_amount_sum > 0
) sub
WHERE il.id = sub.line_id
  AND il.cost_per_kg IS NULL
  AND sub.unit_cost IS NOT NULL;

-- Remaining nulls: one-time snapshot from roll price (frozen after this write).
UPDATE invoice_lines il
SET cost_per_kg = r.price_per_kg
FROM rolls r
WHERE il.roll_id = r.id
  AND il.tenant_id = r.tenant_id
  AND il.cost_per_kg IS NULL
  AND r.price_per_kg IS NOT NULL;
