# Money Representation Decision

**Date:** 2026-08-20

## Problem

Monetary columns were stored as PostgreSQL `real` (IEEE-754 single precision).
This is exact for integers only to 16,777,216; Syrian Pound amounts routinely
exceed this. Verified drift while stored as `real`:

| true | stored | error |
|------|--------|-------|
| 20,000,001 | 20,000,000 | −1 |
| 45,678,903 | 45,678,904 | +1 |
| 137,500,007 | 137,500,000 | −7 |
| 260,000,005 | 260,000,000 | −5 |

`SUM(real)` also returns `real`, so running balances accumulate in single
precision and a trial balance never balances exactly.

## Decision

Store monetary amounts as decimal values with at most two fractional digits.
The canonical precision authority is `packages/shared/src/precision.ts`:
validate at the boundary with `is2dp` and apply `round2dp` once at the
calculation/display edge. Do not multiply values by 100 or reinterpret them as
integer minor units.

- **DB columns:** `numeric(14,2)` for monetary values.
- **Reads:** Drizzle maps monetary numerics to JavaScript numbers at the
  repository boundary.
- **Precision policy:** fractional values up to two decimal places are valid
  for currencies such as USD and EUR; SYP whole-unit display remains unchanged.

## Update — 2026-08-23: decimal completion (QA decimal-fraction audit)

The QA brief required 100% acceptance of decimal fractions in USD invoices
(price 1.5$, discount 0.5$, qty 12.5kg). Live testing proved the mixed state
left by migration 0036 rejected fractional invoice-level discounts and paid
amounts with SQLSTATE 22P02 (`invalid input syntax for type bigint`), because
`invoices.subtotal/total`, ledger legs, vouchers etc. were still BIGINT while
inputs were NUMERIC(14,2).

Completed the conversion (migration `0037_monetary_decimal_completion.sql`):
**every** monetary column is now `NUMERIC(14,2)`; drizzle schemas use
`numeric(..., { mode: "number" })` so repository code paths are unchanged.

Rounding policy changed from whole units (`Math.round`) to **2 decimals
(`round2dp`)** at every parity point:

- `packages/shared/src/entities/Invoice.ts` — lineTotal / computeSubtotal /
  invoiceTotal (backend journaling truth)
- `packages/shared/src/schemas/invoice.schema.ts` — validation superRefine
- `src/core/calculations/invoiceCalc.ts` + `src/domain/entities/Invoice.ts` —
  frontend preview & entity
- `backend/src/.../PostgresInvoiceRepository.ts` — update() subtotal, COGS leg

Sums are rounded once at the edge to kill float accumulation. Display:
`formatMoney` now keeps up to 2 decimals instead of rounding to integers, so
print shows "18.25" not "19". SYP amounts are unaffected (whole-unit inputs
render identically). Regression tests: root `src/__tests__/decimal-parity.test.ts`,
backend `tests/invoice-total-parity.test.ts`.

## Forbidden

- `real` / `float4` / `float8` for money columns.
- `SUM() OVER` or `COALESCE(SUM(...))` on binary floats for balances.

## Migration idempotence & rollback

The migration uses `USING col::bigint` for each affected column, safe whether
the prior type was `real` or `bigint`. Reverting below `bigint` would
reintroduce the precision defect; the decision is forward-only. Existing rows
are re-scaled only to whole units; no value changes magnitude because the
application never stored fractional money.