# remediation/full-cleanup — progress

## Baseline (recorded red → recovered green)

See `docs/REMEDIATION-FULL-CLEANUP-BASELINE.md`. Gates after Phase 1:

| Gate | Status |
|------|--------|
| `npm run typecheck` | green |
| `npm run test` | green (184) |
| `npm run lint` | green (warnings only; `eslint src --max-warnings 50`) |
| `npm run build` | green |

## Phase 1 — DONE

- Deleted dead `src/core/calculations/profitCalc.ts` (no callers).
- `invoiceRemaining` delegates to `@erp/shared` with `returns` + `round2dp`.
- Callers updated (`invoices.sale.new.tsx`); unit test in `invoice-remaining.test.ts`.
- Create path uses `invoiceLedgerLegs` only; balance test in `backend/tests/invoice-ledger-legs-balance.test.ts`.
- Gate hygiene: font package install, auth-context empty-env fix, tsconfig/eslint scope for operational code.

## Phase 2 — DONE

- `recordSyncConflict` no longer swallows insert failures (throws).
- Claim conflict path records the conflict **before** `markRejected`.
- Shared `mapActivationError` used by license-v1 + setup activate routes.
- Tests: `activation-http-status.test.ts`, `sync-conflict-record-fail-closed.test.ts`.

## Next

Phases 3–8 per user brief.
