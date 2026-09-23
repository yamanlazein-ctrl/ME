# OLD-PLAN remediation status (from OLD-VERIFICATION-REPORT.md)

Decisions locked: full phased scope; profit returns by `returns.date`; current names on statements (no snapshots).

## Completed in this pass

### Phase 0 — Semantics
- [x] Profit return attribution by `returns.date` (`PostgresProfitRepository`)
- [x] Docs in `Profit.ts` + statement name policy in `Statement.ts`
- [x] COGS: no live `rolls.price_per_kg` in profit; migration `20261008_cost_per_kg_backfill.sql`
- [x] Test: `backend/tests/profit-return-period.test.ts`

### Phase 1 — Financial exactly-once
- [x] Table `financial_operations` (`20261009_financial_operations.sql`)
- [x] Idempotency middleware reads/writes durable ops beyond 5-minute TTL
- [x] `tryClaim` refuses re-exec when durable result exists; replay on conflict
- [x] VoucherForm disables submit while pending

### Phase 2 — Bounded APIs / UI
- [x] Statement pagination (default 200, max 500) + totals independent of page
- [x] Query params `limit`/`cursor`; `page` on response
- [x] `useParties` / `useInventory` no longer `fetchAllPaged` entire catalog (first page 50)
- [x] `PartyCombobox` uses `/api/parties/search` typeahead

### Phase 3 — Integrity / merge / restore
- [x] `backend/scripts/reconcile-integrity.mjs`
- [x] `mergePartiesUseCase` + `POST /api/parties/merge` + ledger remap migration `20261011`
- [x] Restore drill posts count checks after restore

### Phase 4 — Perf proof
- [x] `perf-harness.mjs` runs timed SQL scenarios (not scaffold-only)

## Still operational / not fully proven at scale
- Desktop application-role RLS (needs env/deploy wiring beyond this code pass)
- Full multi-device settle race matrix under load
- Production soak / 100k–1M EXPLAIN on live data
- UI “load more” for statement pages (API ready; some print views may still request one page)

## How to verify locally
```bash
cd backend
npm test -- tests/profit-return-period.test.ts
node scripts/reconcile-integrity.mjs --url "$DATABASE_URL"
node scripts/perf-harness.mjs --url "$DATABASE_URL"
```
Apply migrations via normal desktop/boot migrator (journal tags 20261008–20261011).
