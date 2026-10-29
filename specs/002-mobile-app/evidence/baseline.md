# Desktop baseline (T003)

Recorded before any change. Environment: Node v22.22.0, PostgreSQL 16.15 (local service), 2026-10-24.
Exported for steps 4–5: `E2E_ADMIN_PASSWORD=CiTestAdmin!Pass9 ALLOW_TEST_SEED=1 NODE_ENV=test` and
`APP_MASTER_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=`.

1. `cd backend && npx tsc --noEmit` → exit 0
2. `cd backend && npm run typecheck:sqlite` → exit 0
3. `cd backend && npm run lint` → exit 0
4. `cd backend && DB_ENGINE=sqlite npx vitest run --maxWorkers=2` → Test Files 204 passed | 10 skipped (214); Tests 1135 passed | 44 skipped (1179); 0 failed
5. `cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/erp_test npx vitest run --maxWorkers=2` → Test Files 215 passed (215); Tests 1182 passed | 1 skipped (1183); 0 failed
6. `npx vitest run` → Test Files 2 failed | 109 passed | 1 skipped (112); Tests 539 passed | 35 skipped (574). The 2 failing files
   (`src/components/invoices/invoiceWeightRecalculation.test.tsx`, `src/components/vouchers/VoucherPartyBalance.test.tsx`) fail
   with `browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1234/...` — the sandbox
   Chromium build differs from the one the browser tests expect. This is an environment fault, present before any change.
   The baseline for step 6 is therefore **2 failed files, 0 failed tests**.
7. `npm run lint` → exit 0

GATE-D rule: every later run must show no more failures than these numbers, and every new test must pass.
