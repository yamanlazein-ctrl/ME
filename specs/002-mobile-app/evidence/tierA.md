# Tier A closing (T084)

Run at the end of the Tier A phases (commit following this file).

## GATE-D (desktop safety) - full, all 7 steps, compared with baseline.md

Backend files were last changed in commit d984225 (Phase 3). All steps re-run after Phase 11:

1. `cd backend && npx tsc --noEmit` → exit 0
2. `cd backend && npm run typecheck:sqlite` → exit 0 (51 files / 53 tables; fingerprint check passed)
3. `cd backend && npm run lint` → exit 0
4. sqlite vitest → Test Files 207 passed | 10 skipped (217); Tests 1145 passed | 44 skipped (1189); **0 failed** (baseline 204/1135: +3 files and +10 tests are the new BC-1/2/3 tests)
5. PG vitest → Test Files 218 passed (218); Tests 1192 passed | 1 skipped (1193); **0 failed** (baseline 215/1182)
6. root `npx vitest run` → Test Files 2 failed | 110 passed | 1 skipped (113); Tests 756 passed | 35 skipped. The 2 failing files are exactly the baseline's (`invoiceWeightRecalculation.test.tsx`, `VoucherPartyBalance.test.tsx`: Chromium executable missing in this sandbox); 0 failed tests beyond them.
7. root `npm run lint` → exit 0

Result: **GATE-D passes** (no more failures than the baseline; every new test passes).

## GATE-M (mobile)

`cd mobile && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run` → exit 0; Test Files 39 passed | 3 skipped (parity, need PG); Tests 178 passed | 13 skipped. `npx prettier --check mobile specs/002-mobile-app` → all files use Prettier code style. `EXPO_PUBLIC_SPIKES=1 npx expo export --platform android` bundles to Hermes bytecode.

## GATE-P (sync parity)

`cd mobile && CERT_PG_URL=postgresql://postgres:postgres@localhost:5432/postgres npx vitest run test/parity` → 3 files, 12 tests passed, 0 field differences: scenarios (a) receipt, (b) 3-line sale, (c) desktop cancels phone sale, (d) voucher replace, (j) expense + new party + receipt + manual cashbox movement, (k) cashbox balance per currency equals the desktop's, (f) block exhaustion, (g) epoch rebase, (e) claim race, (h) killed-and-resumed first download, (i) revoked device. One run of the suite during development showed one file failing to start while other heavy jobs ran on the same PostgreSQL; two reruns passed 12/12.
