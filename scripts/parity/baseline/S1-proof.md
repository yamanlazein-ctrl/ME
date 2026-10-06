# S1 proof — the engine seam changed nothing on PostgreSQL (T031)

Date: 2026-10-03. Branch `clean-desktop-release` (uncommitted S1 working tree).
Database: throwaway PG 17 cluster (bundled `desktop/src-tauri/resources/postgres/bin`), port 55432, `erp_test`.

## Results

| Gate | Command | Result |
|---|---|---|
| Backend unit/contract suite | `cd backend && npm test` | **117 files / 664 tests passed** (incl. new `container-engine-selection.test.ts`) |
| Backend integration | `cd backend && npm run test:integration` | **118 files / 674 tests passed** (was 664 + 10 skipped/failed before the test fixes below) |
| Frontend suite | `npx vitest run` (root) | 270 passed, **1 failed — pre-existing** (`src/dfp029-credentials.test.ts`: `README.md` is deleted in the working tree, not by this feature) |
| Typecheck | `npx tsc --noEmit` root and `backend` | both exit 0 |
| Server boot + health | `tsx src/presentation/server.ts` on erp_test | `/api/health/live` 200 in every integration/e2e run |
| `tests/e2e/financial-lock-in.mjs` | against :8080 / erp_test | **14 passed / 3 failed — pre-existing stale assertions** (see below) |
| `tests/e2e/comprehensive-api.mjs` | against :8080 / erp_test | **not certifiable here** — hard-codes party/roll UUIDs (`SID`, `CID`, `RID`) from one developer database |
| Cloud image | `docker build backend/` | **blocked — pre-existing** build-context defect (`@erp/shared` lives outside `backend/`); recorded in T021-verification.md |

## Test-only fixes (no application code changed)

All failures traced to test fixtures that predate contracts already in HEAD's working tree;
none touched code changed by S1.

- `backend/tests/audit-findings.test.ts` (last edited 2026-09-18):
  - mutations now send `Idempotency-Key` (REPAIR-008, 2026-09-23 → 428 without it);
  - SYP documents carry `exchangeRate` (bf340593 base-currency FX, 2026-09-23);
  - cancels send `expectedVersion` (optimistic concurrency → 400 without it);
  - ledger lookups scoped by `tenant_id` (erp_test holds 615 tenants with colliding `INV-2026-000N` numbers — the test read another tenant's legs);
  - per-run unique fixture rolls (sales consume pieces; a shared roll exhausted across reruns);
  - H1 "reject SYP sale of USD-costed roll" replaced by the owner contract documented in
    `PostgresInvoiceRepository` / `saleCogsConversion.ts` ("buy SYP / sell USD is a normal
    workflow"): the sale is accepted and COGS is converted at the frozen rate (asserted).
  Stable across two consecutive reruns (10/10 each).
- `tests/e2e/_currentContract.mjs` (new): request adapter used by both legacy e2e scripts for the
  same three contracts. `financial-lock-in.mjs` fixtures: rolls get pieces; the entry invoice
  stocks a fresh empty roll (DIAG-أ).

## Remaining `financial-lock-in.mjs` failures (pre-existing, not S1)

1. *Profit two ways* reads `dashboard.todayProfit.syp`, a field the current dashboard no longer returns.
2. *Ordering is chronological* expects ascending; the invoice list contract is newest-first.
3. *Cashbox reduced by transfer expenses* assumes an empty tenant; the balance drifts per run
   (50000 → 635000 → −820000) in the shared test tenant.

These assertions were left untouched: changing them is product-contract work outside this feature.
