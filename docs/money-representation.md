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

Store every monetary amount as **integer minor units in `bigint`**
(option (a) from the brief). SYP has no subunits in practice; the entire
codebase already treats money as whole integer units (every test, entity and
form uses whole numbers). `bigint` is exact over the full range of the system
and — because drizzle maps `bigint` with `mode: 'number'` to a JS `number`
on both read and write — it keeps every repository code path unchanged.

- **DB columns:** `bigint` — declared in the drizzle schemas and enforced by
  migration `0026_monetary_amounts_to_bigint.sql`.
- **Reads:** repository boundary yields JS `number` directly (drizzle
  `bigint`/`mode: number`). Exact for magnitudes ≤ 2^53.
- **Quantities / unit prices** (`quantity_kg`, `price_per_kg`) remain
  `decimal` because they are fractional; the existing repositories already map
  those decimal strings to `Number()`.
- **Precision policy:** one shared constant governs validation and display (see
  `packages/shared` in Phase 5.1); fractional money beyond 0 decimals is
  rejected at validation for SYP, and USD/EUR may adopt a per-currency scale
  later without a schema change (bigint minor units).

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