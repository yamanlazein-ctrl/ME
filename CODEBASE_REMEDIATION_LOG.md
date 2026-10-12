# Codebase remediation log — `CODEBASE_AUDIT_REPORT.md`

Date: 2026-10-11 · Branch: `main` · Base: `2b9b602c` · Nothing committed, pushed or deployed.

Scope: the 31 numbered findings (H-01…H-13, M-01…M-13, L-01…L-05) and the three "suspected" items
(S-01…S-03) of `CODEBASE_AUDIT_REPORT.md`. Each claim was treated as unverified until confirmed in the
source; each fix has a regression test that was run **RED against the HEAD version of the changed file**
and **GREEN after the fix** (unless stated otherwise). Both audit reports are untouched.

**For the second report (`CODEBASE_AUDIT_REPORT_hermes.md`):** before fixing anything there, look up
its file/function in the "Files" column below — the same root cause may already be fixed here.

Status legend: **FIXED** (confirmed, fixed, test RED→GREEN) · **FIXED (unverified run)** (fixed, the
check that proves it could not run here) · **BLOCKED** (confirmed, needs an owner decision or an
external resource) · **NOT A DEFECT / INFO**.

## Summary

| ID          | Status                                                | Root cause (short)                                                                             | Files (both engines where a twin exists)                                                                                                | Regression test                                                                                                          |
| ----------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| H-01        | FIXED                                                 | voucher create never checked the linked invoice's party/type                                   | `PostgresVoucherRepository.ts`, `sqlite/SqliteVoucherRepository.ts`                                                                     | `backend/tests/voucher-ownership-fx-guards.test.ts`                                                                      |
| H-02        | FIXED                                                 | party id not looked up in the voucher's tenant (RLS scopes the row, not the FK)                | same as H-01                                                                                                                            | same                                                                                                                     |
| H-03        | FIXED                                                 | FX gain/loss leg only when currencies differ — not when the same currency has two frozen rates | same as H-01                                                                                                                            | same                                                                                                                     |
| H-04        | FIXED (line discount) / BLOCKED (header discount)     | return price = Σ(q×p)/Σq, ignoring `discount_amount`                                           | `PostgresReturnRepository.ts`, `sqlite/SqliteReturnRepository.ts`                                                                       | `backend/tests/return-net-value-pieces.test.ts`                                                                          |
| H-05        | FIXED                                                 | sale-return bound checked kg only, pieces taken from the client                                | same as H-04                                                                                                                            | same                                                                                                                     |
| H-06        | FIXED                                                 | roll adjustment posted one P&L leg, no contra, no base                                         | `inventoryCountRepository.ts`, `sqlite/helpers/inventoryCountRepository.ts`                                                             | `backend/tests/roll-adjustment-balance-status.test.ts` (+2 assertions updated in `tests/sqlite/roll-adjustment.test.ts`) |
| M-01        | FIXED                                                 | same function never recomputed roll `status`                                                   | same as H-06                                                                                                                            | same                                                                                                                     |
| H-07        | FIXED                                                 | period guards only on create paths                                                             | Cashbox, Statement, Return, Invoice, Expense repos (PG + SQLite); `cashboxUseCases.ts`, `invoiceUseCases.ts`                            | `backend/tests/closed-period-mutations.test.ts`                                                                          |
| H-08        | FIXED (PG; SQLite N/A) — concurrency run not executed | writers only SELECTed; closer's advisory lock had no writer side                               | `dayLockHelper.ts` (+`lockDay`), `sqlite/helpers/dayLockHelper.ts`, `PostgresCashboxRepository.ts`, `sqlite/SqliteCashboxRepository.ts` | covered functionally by H-07 test; no 2-connection race test                                                             |
| H-09        | FIXED                                                 | identity lookup error swallowed → JWT role used                                                | `auth.middleware.ts`                                                                                                                    | `backend/tests/auth-identity-fail-closed.test.ts`                                                                        |
| H-10        | FIXED                                                 | cascade committed, outbox enqueued in a separate swallowed step; only the party unit           | `party.route.ts`, `purgePartyCascadeUseCase.ts`                                                                                         | `backend/tests/party-purge-sync-atomic.test.ts`                                                                          |
| H-11        | FIXED                                                 | master-delete `Result` ignored → tombstone + "created" for a refused delete                    | `syncMaterialize.ts`                                                                                                                    | `backend/tests/sync-delete-refused-no-tombstone.test.ts`                                                                 |
| H-12        | FIXED (residual noted)                                | Drive file id persisted only at `markDone`                                                     | `googledrive/uploadQueue.ts`                                                                                                            | 2 cases added to `backend/tests/drive-upload-queue.test.ts`                                                              |
| H-13        | FIXED                                                 | `fail()` updated by id only, not lease token                                                   | same                                                                                                                                    | same                                                                                                                     |
| M-02        | BLOCKED (owner decision)                              | `day_closes` unique on (tenant, date) though sessions are per currency                         | —                                                                                                                                       | —                                                                                                                        |
| M-03        | FIXED                                                 | fixed 1e-9 tolerance vs float error that grows with magnitude                                  | `packages/shared/src/precision.ts`                                                                                                      | `packages/shared/src/precision.test.ts`                                                                                  |
| M-04        | FIXED                                                 | 5xx left the in-flight claim for the 300 s TTL                                                 | `idempotency.middleware.ts` (+`releaseClaim`), `idempotency-handler.middleware.ts`                                                      | `backend/tests/idempotency-release-after-5xx.test.ts`                                                                    |
| M-05        | FIXED — test runs on PG only                          | stamp failure lost the checked-out client                                                      | `orm/drizzle.ts`                                                                                                                        | `backend/tests/tenant-pool-stamp-failure.test.ts`                                                                        |
| M-06        | FIXED                                                 | admin lockfile missing `@fontsource/ibm-plex-sans-arabic`                                      | `admin-dashboard/package-lock.json`                                                                                                     | `npm ci --dry-run`                                                                                                       |
| M-07        | FIXED                                                 | CI ran backend tests from root; SyncConflicts step ran a root test inside `backend/`           | `.github/workflows/ci.yml`                                                                                                              | exact commands re-run                                                                                                    |
| M-08        | FIXED (discovery)                                     | `testDir` relative to a config already in `tests/e2e`                                          | `tests/e2e/playwright.comprehensive.config.ts`                                                                                          | `--list`                                                                                                                 |
| M-09        | FIXED                                                 | root config ignores `backend/**`; backend had no config                                        | `backend/eslint.config.js` (new), `eslint.config.js`, `backend/package.json`, `ci.yml`                                                  | `npm run lint` in backend + forbidden-import probe                                                                       |
| M-10        | FIXED (unverified run)                                | `$$` escaped Compose interpolation; `APP_MASTER_KEY` missing                                   | `backend/docker-compose.yml`                                                                                                            | YAML parse only (no Docker here)                                                                                         |
| M-11        | FIXED (Windows verified; Linux by review)             | harness killed the wrapper, not the server tree                                                | `backend/scripts/processTree.mjs` (new), `verify-sync-multidevice.mjs`, `run-integration.mjs`                                           | process-tree probe                                                                                                       |
| M-12        | PARTLY FIXED / BLOCKED                                | advisories                                                                                     | `admin-dashboard/package-lock.json`                                                                                                     | `npm audit`                                                                                                              |
| M-13        | FIXED                                                 | year-close summed nominal amounts across currencies                                            | `financialYearRepository.ts`, `sqlite/helpers/financialYearRepository.ts`                                                               | `backend/tests/year-close-base-balance.test.ts`                                                                          |
| L-01        | FIXED                                                 | default SQLite test DB was a bare temp file → backup root = its grandparent                    | `backend/vitest.config.ts`                                                                                                              | full SQLite suite                                                                                                        |
| L-02        | FIXED (test env) / BLOCKED (production locale)        | test DB created with the cluster's default locale; the parity tests assume C                   | `backend/scripts/ensure-test-db.mjs`, `.github/workflows/ci.yml`                                                                        | `search-parity.test.ts` (passes on a C database); probe DB created C/C                                                   |
| L-03        | FIXED                                                 | admin login labels not tied to inputs                                                          | `admin-dashboard/src/pages/LoginPage.tsx`                                                                                               | `tsc` + `oxlint` (admin has no test runner)                                                                              |
| L-04        | FIXED (needs commit by owner)                         | `Cargo.lock` / `desktop/package-lock.json` git-ignored                                         | `.gitignore`                                                                                                                            | `cargo metadata --locked`, `npm ci --dry-run`                                                                            |
| L-05        | FIXED (unverified run)                                | integration runner swallowed every migration error as SKIP                                     | `backend/scripts/run-integration.mjs`                                                                                                   | `node --check`                                                                                                           |
| S-01        | FIXED                                                 | module caches never reset at session end; in-flight old load reused                            | `useParties.ts`, `useInventory.ts`                                                                                                      | `src/presentation/hooks/__tests__/useParties.session.test.ts`                                                            |
| S-02        | BLOCKED (owner decision)                              | JS `Math.round` vs SQL `ROUND` half-cent                                                       | —                                                                                                                                       | —                                                                                                                        |
| S-03        | INFO                                                  | import cycles; no failure                                                                      | —                                                                                                                                       | —                                                                                                                        |
| STYLE-01…04 | NOT DONE (out of scope)                               | Prettier/ESLint/whitespace/rustfmt drift                                                       | —                                                                                                                                       | —                                                                                                                        |

## Per finding — evidence, fix, results

### H-01 / H-02 / H-03 — voucher create (one function, both engines)

- **Evidence (H-01):** `create()` selected `total, paid, status, currency, exchangeRate` from the invoice
  but never `partyId`/`type`; nothing in the route or use case compared them. The voucher form already
  filters invoices by `type === (receipt ? "sale" : "entry")` and `partyId` (`VoucherForm.tsx:161,183`),
  so the server rule matches the UI — no business rule invented.
- **Evidence (H-02):** no party lookup at all in `create()`; RLS covers `vouchers`, not the referenced id.
- **Evidence (H-03):** party leg uses the invoice's frozen rate, cash leg the voucher rate, but the FX leg
  ran only under `partyCurrency !== voucherCurrency`.
- **Fix:** inside the transaction — party must exist in `ctx.tenantId` with `kind === partyKind`; a linked
  invoice must belong to that party and be `sale` for a receipt / `entry` for a payment. FX leg condition
  is now `partyCurrency !== voucherCurrency || partyFx !== fxRate` (the existing sign rules unchanged).
- **Tests:** new file, 4 tests — RED 4/4 at HEAD, GREEN 4/4 (SQLite). 18 existing voucher/settlement
  files (90 tests) pass on SQLite.

### H-04 / H-05 — sale returns

- **Evidence:** `price` = `SUM(q×p)/SUM(q)` in both the linked and unlinked branches; `lineTotal()` in
  `packages/shared/src/entities/Invoice.ts:40` subtracts `discountAmount`. `piecesByRoll` = client pieces,
  added to stock with no bound.
- **Fix H-04:** per-roll price = `SUM(GREATEST(0, q×p − discount))/SUM(q)` (the dashboard's existing
  `lineNet` expression; SQLite twin uses scaled `MAX(0, …×… − discount×100)`).
- **Fix H-05:** sale returns: pieces ≤ (pieces sold to the party from the roll − its earlier returned
  pieces). **Decision taken (please confirm):** a remnant sold with 0 pieces (the invoice schema allows
  it; the return schema forces ≥1) is returned **weight-only** (0 pieces) instead of being refused — the
  existing test `return-same-roll-multiple-invoices` already returns such sales.
- **Not fixed — BLOCKED:** the invoice-header `discount`/`tax`/`shipping` are still not allocated to
  returns. How they are refunded is a business decision (pro-rata? never?).
- **Tests:** new file, 2 tests — RED at HEAD (H-05: "promise resolved instead of rejecting", remnant
  20 kg/3 pieces vs 2); H-04 isolated RED "expected 100 to be 80"; GREEN 2/2 + the 2 existing return
  files (8 tests).

### H-06 / M-01 — `applyRollAdjustment`

- **Evidence:** one `expense` leg, no contra, no base columns; `status` never updated.
- **Fix:** balanced pair `expense` + `inventory_asset` (nothing reads `inventory_asset` for reports, so no
  report changes); base filled for USD rolls. A roll carries no frozen FX rate, so **non-USD adjustments
  keep NULL base** (the existing legacy rule) — choosing a rate would be an assumption. Status: exhausted →
  in_stock when kg > 0; in_stock → exhausted at 0; `reserved` untouched.
- **Tests:** new file, 2 tests — RED 2/2 at HEAD; GREEN. `tests/sqlite/roll-adjustment.test.ts` asserted
  the single unbalanced leg — updated to the balanced pair (strengthened, not weakened); 17 pass.

### H-07 — closed periods on mutation paths

- **Evidence:** besides the two cited paths, these also had no guard: invoice update + cancel, return
  create + cancel, expense cancel (`grep assertDayUnlocked|assertYearOpen`). No DB trigger exists.
- **Fix:** year guard on invoice update (old **and** new date) / cancel, return create / cancel, settle;
  day+year guard on manual-movement delete and expense cancel (mirrors their create). Use cases now pass
  the "closed" message through (invoice cancel, manual-movement delete).
- **Tests:** new file, 4 tests — RED 4/4 at HEAD, GREEN.

### H-08 — period guard vs close race (PostgreSQL)

- **Evidence:** `assertYearOpen`/`assertDayUnlocked` only SELECT; `lockYear` is exclusive on the closer side
  only; `closeDay` took no lock.
- **Fix:** writers take `pg_advisory_xact_lock_shared` on the same `tenant:year:Y` / `tenant:day:D` keys;
  `closeDay` takes the exclusive day key (`lockDay`). SQLite: every write is `BEGIN IMMEDIATE`, already
  serialized (`lockDay` is a no-op twin like `lockYear`).
- **Not run:** a two-connection barrier test. Verified by source + the PG suite (see Results).

### H-09 — auth fail-open

- **Fix:** identity lookup error → `503 SERVICE_UNAVAILABLE`, no `next()`. Denylist errors already
  fell to the outer catch (401).
- **Test:** new, RED at HEAD ("next called once"), GREEN.

### H-10 — party cascade purge vs sync

- **Fix:** with sync on, purge + every unit commit in one `withTenantTx`; an enqueue error rolls the purge
  back and answers via `respondTransactionFailure`. The use case now returns what it cancelled; the route
  enqueues `invoice:cancel` / `voucher:cancel` (with the version each cancel was checked against) before
  `party:delete`, so the hub can replay the cascade (its party delete would otherwise be refused — H-11).
- **Test:** new, 2 tests — RED 2/2 at HEAD; GREEN; plus party-delete-http / completeness / atomicity (23).

### H-11 — sync delete Result ignored

- **Fix:** keep the Result of `cancelParty/deleteFabric/deleteColor/deleteRoll`; `!ok` throws inside the
  transaction → tombstone rolled back, unit reports `failed` (retryable).
- **Test:** new — RED ("expected 'created' not to be 'created'"), GREEN; tombstone/replay suites (25) pass.

### H-12 / H-13 — Drive upload queue

- **Fix H-12:** the accepted Drive file id is stored on the row right after upload; a retry first verifies
  that id and only uploads again if Drive no longer has it. **Residual:** if the upload response itself is
  lost (Drive created the file, we never saw its id) a duplicate is still possible — closing that needs a
  Drive-side lookup (e.g. appProperties with the stable key); not done.
- **Fix H-13:** every claim-owned write (`fail`, auth-block, id persist, markDone) is conditioned on the
  current lease token.
- **Tests:** 2 new cases — RED at HEAD (H-12 "expected 5 to be 4"; H-13 "failed" vs "done"), GREEN 11/11;
  the other 7 drive files (60 tests) pass. (First H-12 attempt passed at HEAD because folder checks also
  call `getFile`; the injection was narrowed to uploaded file ids.)

### M-02 — day close per currency — BLOCKED

Confirmed: `idx_day_closes_tenant_date` unique on (tenant, date) while sessions/close figures are per
currency. Two valid designs (close per currency → new unique key + migrations on both engines + how
`isDayLocked` treats the other currency; or one atomic close of all currencies). Owner decision needed.

### M-03 — `is2dp` — FIXED

Tolerance `max(floor, 4·ε·|x|)` (float error bound of `v×10^k`); third decimals still rejected
(`10000000.295` false). Same for `is4dp`; `hasMoreThan2dp` = `!is2dp`. Validation only — rounding
(`round2dp`) untouched. Test RED at HEAD, GREEN 3/3.

### M-04 — idempotency claim after 5xx — FIXED

`releaseClaim()` deletes only a `status_code = 0` claim (DB) / placeholder (Redis). A write that did
commit before the 5xx is still caught on retry by the existing unique `(tenant_id, client_operation_id)`
indexes on invoices/vouchers/returns/expenses/manual_movements/ledger_entries (migration
`20261007_client_operation_id.sql`) — the key is that id. Test RED ("409"), GREEN.

### M-05 — pool client leak — FIXED

Stamp rejection → `client.release(err)` (destroy) then rethrow; the callback form passes a no-op `done`.
`TenantScopedPool` exported for the test. Test is PostgreSQL-only (see Results).

### M-06 / M-12 — dependencies

- M-06: `npm install --package-lock-only` added only the missing font (+ npm's optional wasm sub-entries);
  `npm ci --dry-run` now succeeds.
- M-12 admin: `npm audit fix --package-lock-only` → nanoid 3.3.20, source-map-js; admin audit 0.
- M-12 root/backend — **BLOCKED:** every remaining fix npm offers is a semver-major **downgrade**
  (`drizzle-kit@0.18.1`, `knip@6.41.0`, `tsc-alias@1.0.11`); dev/build tooling only; `--omit=dev`
  audits were already clean. Needs a deliberate upgrade path, not `audit fix --force`.

### M-07 — CI paths — FIXED

Migration guard now `cd backend && npx vitest run tests/…` (15/15 pass locally; root form reproduced
"No test files found"); SyncConflicts step uses a subshell so the root contract test runs from the root
(reproduced "No test files found" inside backend; 4 pass from root). `dfp008-ci-gates` 3/3. Note: CI now
reaches **Lint**, which still fails on Prettier drift (STYLE-01) — not touched (no bulk formatting).

### M-08 — Playwright discovery — FIXED (discovery only)

`testDir: "."` + `testIgnore: ["cert-*/**"]` (cert suites need the cert stack and have their own config).
With the env the specs require at import time (`PLAYWRIGHT=1`, `E2E_ADMIN_PASSWORD`, `DATABASE_URL`,
`ERP_TENANT_ID`, `ERP_ADMIN_EMAIL/PASSWORD` — placeholder values, listing only): **180 tests in 29
files**; the old config: "No tests found". Tests not executed (need a live 8081 stack).

### M-09 — backend lint — FIXED

New `backend/eslint.config.js` carrying only the D-006 `pg` import boundary (moved from the dead block in
the root config); script `eslint src` (the `--ext` flag is gone in flat config); CI step added. `npm run
lint` in backend exit 0; a probe `import pg from "pg"` in a repository file → exit 1 with the rule.
`no-unused-vars` policy unchanged (not a defect decision).

### M-10 — Compose — FIXED (not run)

Single-`$` interpolation and `APP_MASTER_KEY: ${APP_MASTER_KEY:?…}`. Docker is not installed here; only a
YAML parse was done. A password with URL-special characters must be percent-encoded.

### M-11 — harness process trees — FIXED

`processTree.mjs`: POSIX → spawn `detached` + `kill(-pid)`; Windows → `taskkill /T /F`; restart waits
until the port stops answering. Windows probe: wrapper and grandchild both gone. Could not reproduce the
Linux orphan here (a plain kill on Windows also took the grandchild in the probe), so the Linux path is
verified by review only. Harnesses not executed (need PG + 3 servers).

### M-13 — year close — FIXED

Per document: all legs have base → |Σbase_debit − Σbase_credit| > 0.01 (1-cent rounding tolerance);
single-currency legacy without base → nominal; mixed currency without base → blocker (unverifiable).
Test RED 2/2 at HEAD (cross-currency flagged; base-unbalanced doc not flagged), GREEN; year-closing.test
passes.

### L-01 — FIXED

Default `SQLITE_PATH` is now `<tmp>/motard-test-<pid>-<ts>/data/motard.db`. **Also confirmed on this
Windows machine:** the old default made the backup root `C:\Users\Taw\AppData\Local`, so tests wrote 48
`pre-operation-*.zip` files to `C:\Users\Taw\AppData\Local\backups` (test data, not the owner's
`motard-erp` folder). Not deleted — owner to decide.

### L-02 — FIXED for the test environment / BLOCKED for production

- **Evidence:** `tests/sqlite/search-parity.test.ts` documents "no folding under locale C"; CI created
  `erp_test` with a plain `CREATE DATABASE` on `postgres:16-alpine` (default `en_US.utf8`), and
  `ensure-test-db.mjs` did the same — so the parity tests fail there (what the auditor saw). This
  machine's cluster is C/C, which is why they pass locally.
- **Fix:** both now create the test database with `TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`.
  Probe: `ensure-test-db` on a throwaway `erp_l02_probe` → created C/C, migrated, then dropped.
- **Also fixed in the same CI step:** it ran `docker compose up postgres redis` without the variables the
  compose file requires (`${POSTGRES_USER:?…}` etc.), so it could never start; test-only env added
  (including `APP_MASTER_KEY`, which M-10 now also requires there).
- **BLOCKED:** the production hub's (Render) collation is unknown; whether customer search should fold
  non-ASCII case is a product decision.

### L-03 — FIXED

`htmlFor`/`id` on both admin login fields. Admin `tsc --noEmit` 0, `oxlint` 0. No admin test runner.

### L-04 — FIXED (owner must commit)

The two lock files were only ignored, not missing; un-ignored. `cargo metadata --locked --offline` exit 0;
`desktop npm ci --dry-run` up to date. They now show as untracked — commit them to make releases frozen.

### L-05 — FIXED (not run)

The integration runner uses drizzle's journal-aware migrator and exits 1 on any migration error. The
`fabric_erp` rename hack was dead (0029 no longer contains the literal).

### S-01 — FIXED

Both module caches (`useParties`, `useInventory`) now listen to the existing `SESSION_ENDED_EVENT`: clear
at once, and a load from an older session generation is dropped. Test RED at HEAD (B's sign-in reused A's
held load → timeout), GREEN; hooks 35/35.

### S-02 — BLOCKED · S-03 — INFO

S-02 changes rounding → CLAUDE.md requires an owner decision. S-03: cycles only, no failure observed.

### Re-check of the report for further findings

Appendix B (321 Semgrep matches): 307 `no-console-leftover` in scripts/harnesses and 14
`no-hardcoded-secrets`, all synthetic test/harness credentials for disposable installs (checked each
location, e.g. `Parity-Pass-2026!`); no real secret. Knip: candidates only (one duplicate export alias
`MAX_2DP_MSG`). Appendices C/D/E are style output (STYLE-01…04), not functional defects. No new
functional finding.

## Results (actual runs, this machine, after all fixes)

| Check                                                                                                 | Result                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend suite, SQLite (`DB_ENGINE=sqlite npx vitest run --maxWorkers=2`)                              | 168 files passed, 1 failed, 8 skipped · 942 tests passed, 40 skipped. The 1 failure was my new M-05 test building its pool during collection on SQLite — fixed (now skipped there). Re-run of all new/changed test files: 11 passed + 1 skipped, 44 tests passed |
| Backend suite, PostgreSQL 17 (disposable cluster on :56437, `erp_test`, `npm test -- --maxWorkers=2`) | **178/178 files, 987/987 tests passed**                                                                                                                                                                                                                          |
| New regression tests on PostgreSQL (10 files)                                                         | 20/20 passed (M-05 ran, not skipped; M-05 RED at HEAD: "timeout exceeded when trying to connect")                                                                                                                                                                |
| Frontend + `packages/shared` (`npx vitest run --maxWorkers=2`)                                        | 84/84 files, 365/365 tests passed                                                                                                                                                                                                                                |
| `npx tsc --noEmit` root / backend                                                                     | exit 0 / exit 0                                                                                                                                                                                                                                                  |
| `npm run typecheck:sqlite`                                                                            | passed (51 files / 53 tables; fingerprint 60 tables, 60 PK, 24 UNIQUE, 442 CHECK, 73 FK, 133 indexes, 11 triggers)                                                                                                                                               |
| `npm run build` (frontend)                                                                            | exit 0                                                                                                                                                                                                                                                           |
| Root `npm run lint`                                                                                   | 245 errors / 50 warnings — **identical to the pre-existing baseline** (all errors are Prettier drift, STYLE-01). My lines were formatted by hand, or by Prettier only on files that were clean at HEAD or are new                                                |
| Backend `npm run lint` (new)                                                                          | exit 0; probe with a forbidden `pg` import → exit 1                                                                                                                                                                                                              |
| `node --test desktop/scripts/dfp008-ci-gates.test.mjs`                                                | 3/3                                                                                                                                                                                                                                                              |
| CI migration-guard command (fixed form)                                                               | 2 files, 15 tests passed                                                                                                                                                                                                                                         |
| Admin `tsc --noEmit` / `oxlint`                                                                       | exit 0 / exit 0                                                                                                                                                                                                                                                  |
| Admin `npm ci --dry-run` / `npm audit`                                                                | ok / 0 vulnerabilities                                                                                                                                                                                                                                           |
| Desktop `cargo metadata --locked --offline` / `npm ci --dry-run`                                      | exit 0 / up to date                                                                                                                                                                                                                                              |

**Not run (and why):** `cargo test` (memory; no Rust code changed); TesterArmy / Playwright browser suites
(need a live stack; M-08 is a discovery fix); the multi-device sync and integration harnesses (need PG +
3 servers); Docker Compose (Docker is not installed); a two-connection race test for H-08.

## Remaining open items for the owner

1. **Decisions:** M-02 (day close per currency vs one global close); H-04 header discount/tax/shipping on
   returns; S-02 rounding; L-02 production collation; H-05 remnant rule (implemented as weight-only —
   please confirm); H-06 base amounts for non-USD stock adjustments (left NULL).
2. **Dependencies:** M-12 root/backend advisories need a planned upgrade (npm only offers major
   downgrades).
3. **Commit** `desktop/src-tauri/Cargo.lock` and `desktop/package-lock.json` (L-04) with the next commit.
4. **Test leftovers:** 48 `pre-operation-*.zip` test backups in `C:\Users\Taw\AppData\Local\backups`
   (written by the old L-01 default). Not deleted.
5. CI now gets past the migration guard and reaches **Lint**, which fails on Prettier drift (STYLE-01)
   until a separate, authorised formatting pass.
6. H-12 residual: an upload whose response is lost can still duplicate (needs a Drive-side lookup).

---

# Second report — `CODEBASE_AUDIT_REPORT_hermes.md` + `CODEBASE_AUDIT_FINDINGS_hermes.json`

Date: 2026-10-12 · Branch `main` · Base `2b9b602c` plus the uncommitted fixes above. Nothing committed,
pushed or deployed. Both Hermes files untouched.

Scope: all 16 JSON `findings` (F-001…F-019 minus the positives), the 3 `positive_findings` (F-003,
F-005, F-009), the 3 `disproved_claims`, the 15 `subagent_leads_unverified` (C1-05…C1-20), the
`remaining_work` items, and the requested extra-care review of **Customers and Suppliers** (new IDs
CS-01…CS-07 below). Each claim was checked against the CURRENT code; anything already fixed by the
first round is cross-referenced, not redone. RED = the regression test run against the HEAD version
of the changed file(s); GREEN = after the fix.

## Summary

| ID    | Status                             | Evidence / root cause (short)                                                                                                                                                                                                                                                                                                                        | Files                                                                                                                                                                                                                                      | Regression test                                                                                                     |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| F-001 | ALREADY FIXED (= M-07)             | both CI path bugs fixed in round 1; current ci.yml runs `cd backend && …` and a subshell                                                                                                                                                                                                                                                             | `.github/workflows/ci.yml`                                                                                                                                                                                                                 | M-07 commands re-run (15 + 3 tests)                                                                                 |
| F-002 | NOT FIXED — out of scope           | 245 Prettier errors are pre-existing drift; bulk formatting is excluded by instruction. Lint still exactly 245/50 after this round                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                          | `npm run lint`                                                                                                      |
| F-003 | INFO (positive)                    | prod audits clean; dev advisories tracked as M-12                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-004 | FALSE (runtime) — guard test added | live PG: 49 FORCE-RLS tables, **0 without a policy**; `sync_state` HAS `sync_state_tenant_isolation` (0051 — the auditor's grep missed the quoted `"sync_state"`); its tenant_id is the PK (NOT NULL). The 4 nullable-tenant tables each have the platform-aware policy                                                                              | —                                                                                                                                                                                                                                          | `backend/tests/rls-forced-tables-have-policy.test.ts` (PG)                                                          |
| F-005 | INFO (positive)                    | —                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-006 | BLOCKED (owner + prod data)        | historical migration 0024→0026; current schema correct; needs a production data inspection                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-007 | PARTLY CONFIRMED — not fixed       | filename claim true; content check: use cases referenced by tests — parties 6/8, vouchers 2/4, orders 1/8, returns 1/4, expenses 1/4, inventory 1/15, notifications 0/6, printing 0/5, dashboard 0/1, super-admin 0/1, settings 1/2, statements 1/1. Repositories are tested directly; this round added route-level tests for orders, users, parties | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-008 | BLOCKED (owner decision)           | same as S-02: rounding change gated in source                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-009 | INFO (positive)                    | —                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| F-010 | FIXED                              | `POST /orders` used `idempotency("POST")` without `required`; the web client always sends a key (BaseHttpClient)                                                                                                                                                                                                                                     | `order.route.ts`; e2e helper `tests/e2e/_helpers/mock-data.ts` (already 428 on invoices)                                                                                                                                                   | `backend/tests/order-create-idempotency.test.ts` RED (500) → GREEN (428)                                            |
| F-011 | FIXED                              | `HeaderField`/`CardField` (sale, entry, print-receive, line cards) had unassociated labels                                                                                                                                                                                                                                                           | `FormField.tsx` (shared wiring + opt-in `autoWireId`), `InvoiceFormLayout.tsx`, `PartyCombobox.tsx`, `SupplierInlineCombobox.tsx`, `SaleLineCard.tsx`, `invoices.sale.new.tsx`, `invoices.entry.new.tsx`, `invoices.print-receive.new.tsx` | `src/components/invoices/InvoiceFormLayout.labels.test.tsx` RED 4/4 → GREEN 4/4                                     |
| F-012 | PIN part FALSE; floor FIXED        | reset sets `password_hash`, not `pin_hash`; `isWeakPin` only judges 4-digit PINs and reset required ≥6 chars, so no weak PIN can pass. Floor raised 6 → 8 = the setup wizard's own account-password rule                                                                                                                                             | `user.route.ts`                                                                                                                                                                                                                            | `backend/tests/user-reset-password-policy.test.ts` RED → GREEN (422)                                                |
| F-013 | FALSE                              | PG purge drops `trg_ledger_entries_append_only` INSIDE its transaction and recreates it in `finally` (`dyePurgeRepository.ts:478,590`) — the auditor grepped migrations only. Ran on live PG: `dye-purge-cash-legs.test.ts` deletes the 3 ledger rows and passes                                                                                     | —                                                                                                                                                                                                                                          | existing test, run on PG                                                                                            |
| F-014 | FIXED                              | any existing file path was opened/hashed/parsed; `/backup/verify-path` was also **registered twice** (dead copy) and not desktop-gated; the setup wizard's restore-path duplicated the validator                                                                                                                                                     | `backup.route.ts` (`receiveShellPath` exported: absolute + `.zip` only, the shell picker's filter), `setup.route.ts` (uses it)                                                                                                             | 2 cases in `backend/tests/sqlite/restore-path.test.ts` RED (server opened the live DB → `BACKUP_NOT_A_ZIP`) → GREEN |
| F-015 | FIXED                              | /settings/users edited an in-memory list; no POST /users exists (accounts join by invitation)                                                                                                                                                                                                                                                        | `UsersApiService.ts` (new), `api/index.ts`, `container.ts`, `settings.users.tsx`, `useSettings.ts` (fake seed user + CRUD removed)                                                                                                         | `src/infrastructure/api/UsersApiService.test.ts`                                                                    |
| F-016 | FIXED                              | /settings/activity showed a device-local array; now the durable `GET /api/audit-logs`, paged, no client "clear"                                                                                                                                                                                                                                      | `AuditApiService.ts`, `settings.activity.tsx`                                                                                                                                                                                              | same file (listPage + page contract)                                                                                |
| F-017 | FIXED                              | print visibility lived in one browser's localStorage; now `settings.printing.invoiceVisibility` (replicated); the legacy local copy is read until the next save                                                                                                                                                                                      | `visibility.ts`, `useSettings.ts` (`updatePrintVisibility`; `updatePrinting` merges only its own 4 fields)                                                                                                                                 | `src/presentation/hooks/useSettings.persistence.test.ts`                                                            |
| F-018 | FIXED                              | forms copied built-in defaults before the GET; a failed GET also left them saveable                                                                                                                                                                                                                                                                  | `useSettings.ts` (`settingsLoaded`, `useSettingsDraft`, retry on failure), `settings.company.tsx`, `settings.printing.tsx`, `settings.invoice.tsx`                                                                                         | same file — RED 5/5 at HEAD → GREEN                                                                                 |
| F-019 | FIXED                              | close/reopen refreshed 3 ad-hoc keys                                                                                                                                                                                                                                                                                                                 | `closing.tsx`                                                                                                                                                                                                                              | `src/routes/closing.invalidation.test.ts` RED → GREEN                                                               |
| C1-05 | FIXED                              | 5 implemented reports had no tile (incl. **ذمم الموردين/payables**); "الأطراف" opened customers only                                                                                                                                                                                                                                                 | `reports.index.tsx`                                                                                                                                                                                                                        | `src/routes/reports.contracts.test.ts`                                                                              |
| C1-06 | PARTLY FIXED / BLOCKED             | debtors sorted by SYP only → USD tie-break added; ranking SYP vs USD needs FX = owner decision. Also fixed: a failed load showed "لا بيانات" (now an error + retry)                                                                                                                                                                                  | `reports.$slug.tsx`                                                                                                                                                                                                                        | same                                                                                                                |
| C1-08 | FALSE                              | `DriveQueueJob` is used only for `/drive/queue` and has no `entityId` field                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| C1-09 | FIXED (same root cause as F-011)   | raw `<Label>` without htmlFor in 6 settings routes                                                                                                                                                                                                                                                                                                   | `settings.{company,invoice,payment-methods,printing,units,warehouses}.tsx`                                                                                                                                                                 | `src/routes/settings.labels.test.ts` RED 6 files → GREEN 12/12                                                      |
| C1-10 | NOT FIXED — UX lead                | `window.confirm` in 11 places; not a data defect (replaced only on the rewritten users page)                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| C1-11 | FIXED (with F-015)                 | plaintext password field removed                                                                                                                                                                                                                                                                                                                     | `settings.users.tsx`, `useSettings.ts`                                                                                                                                                                                                     | `UsersApiService.test.ts`                                                                                           |
| C1-12 | BLOCKED (owner decision)           | settings sub-nav lists pages `ROLE_ALLOWED_PATHS` does not grant non-admins; backend enforces either way — which is intended?                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| C1-13 | FIXED                              | "مدير الظام" → "مدير النظام"                                                                                                                                                                                                                                                                                                                         | `useSettings.ts`                                                                                                                                                                                                                           | persistence test                                                                                                    |
| C1-14 | FIXED                              | inline `Math.round(x*100)/100` → `round2dp` (identical result)                                                                                                                                                                                                                                                                                       | `reports.index.tsx`                                                                                                                                                                                                                        | tsc                                                                                                                 |
| C1-15 | NOT A DEFECT — feature request     | print-center lifecycle view                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| C1-16 | FIXED                              | settings import changed memory only, then said "restored"                                                                                                                                                                                                                                                                                            | `useSettings.ts` (`applyImportedSettings`), `settings.backup.tsx`                                                                                                                                                                          | persistence test                                                                                                    |
| C1-17 | FIXED                              | export carried the fake user + password + local activity                                                                                                                                                                                                                                                                                             | `useSettings.ts` (`exportableSettings`), `settings.backup.tsx`                                                                                                                                                                             | persistence test                                                                                                    |
| C1-18 | INFO — left                        | `company.nameEn` never shown/edited; removing it changes the stored shape                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                          | —                                                                                                                   |
| C1-19 | FIXED                              | nav showed every group (admin-only included) until the role resolved                                                                                                                                                                                                                                                                                 | `AppShell.tsx`                                                                                                                                                                                                                             | `reports.contracts.test.ts`                                                                                         |
| C1-20 | MITIGATED (with F-017/F-018)       | two printing forms remain (design), but neither saves defaults nor reverts visibility                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                          | persistence test                                                                                                    |

**The 3 `disproved_claims`** (Drive token bridge "absent", useVouchers invalidation "missing",
inventory `toast.error` on success): Hermes already disproved them; re-checked the first two at source
(`google_ipc.rs` defines and calls `google_access_token`; `useVouchers.ts` calls
`invalidateFinancialViews(qc)`) — still disproved. Not re-opened.

Note: the group-C sub-agent's own IDs C1-01…C1-04 and C1-07 are not listed separately in either
Hermes file; they are the findings promoted to F-015…F-019 (the report cites "C1-02" for the activity
log = F-016). Counted once, under their F-numbers.

### Customers & Suppliers — extra-care review (new findings)

| ID    | Status                   | Defect                                                                                                                                                                                                                | Files                                                                                                                                                                                                        | Test                                                                                                                                    |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| CS-01 | FIXED                    | `POST /customers` / `/suppliers` had no idempotency; the client REPLAYS keyed POSTs after an ambiguous network error. At HEAD the replay hit the duplicate-name guard → a false 422 for a save that succeeded         | `party.route.ts` (`idempotency("POST")`, not required)                                                                                                                                                       | `backend/tests/party-create-idempotency.test.ts` RED (422) → GREEN (201, same id, one party)                                            |
| CS-02 | FIXED                    | a field cleared in the edit dialog could never be removed: `toPatch` sent `undefined` (dropped from JSON), the repo stored `""` for a sent empty string, and the shared schema mapped a blank email to "not provided" | `PartyFormDialog.tsx` (`toPatch`), `packages/shared/src/schemas/party.schema.ts` (clearable email on update), `PostgresPartyRepository.ts` + `sqlite/SqlitePartyRepository.ts` (`"" → NULL`, 17 text fields) | `PartyFormDialog.edit.test.ts` RED → GREEN; `backend/tests/party-update-clear-and-occ.test.ts` RED (`['', 'old@x.co', '', '']`) → GREEN |
| CS-03 | FIXED                    | optimistic concurrency defeated on the UI path: with no version in the patch the API client re-read the CURRENT version, so another device's edit was overwritten                                                     | `PartyFormDialog.tsx` (sends the opened version), `PartyDetails.tsx` (notes tab)                                                                                                                             | `PartyFormDialog.edit.test.ts`; stale-version 422 in `party-update-clear-and-occ.test.ts`                                               |
| CS-04 | FIXED                    | customer/supplier list stayed stale after an edit or a balance change: the memo keyed on `list.length` while the cache replaces objects in place                                                                      | `PartyTable.tsx`                                                                                                                                                                                             | `src/components/parties/PartyTable.refresh.test.ts`                                                                                     |
| CS-05 | FIXED                    | list CSV export used `Math.round` on money (USD 12.50 → 13)                                                                                                                                                           | `PartyTable.tsx`                                                                                                                                                                                             | same                                                                                                                                    |
| CS-06 | FIXED                    | party picker showed «الاسم غير موجود + إضافة» when the SEARCH FAILED (server dedup by name prevents the duplicate; the message was false)                                                                             | `PartyCombobox.tsx`                                                                                                                                                                                          | same                                                                                                                                    |
| CS-07 | FIXED (with C1-05/C1-06) | supplier balances report unreachable; debtors-report failure shown as empty                                                                                                                                           | see C1-05/C1-06                                                                                                                                                                                              | `reports.contracts.test.ts`                                                                                                             |

**Verified sound in the review (no change):** create/update map every schema field to its column on
both engines; opening balance edits go through the versioned `/opening` route; deletion uses the impact
sheet + cascade (round-1 H-10); list search is name/code server-side and name/company/code/phone/email/
city client-side over the full cache; the outstanding/aging tab is strictly per currency; party balances
report reads the ledger (opening + documents + payments); party RBAC (writes admin/accountant, reads all
roles) as the Hermes report states.

### Remaining work list (JSON `remaining_work`) — what this round did

- Sync replay idempotency / conflict data loss: round 1 H-10/H-11 + existing S-01 tests; no new finding.
- Rust `unwrap`/DPAPI, backup partial-state, webview localStorage at factory reset, `syncCoverage.ts`:
  **NOT examined** this round (no findings claimed).
- Frontend group C: done above (F-015…F-019, C1-xx). Every test suite was run (see Results).

## Results (actual runs, after this round)

| Check                                                  | Result                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend, PostgreSQL 17 (disposable :56437, `erp_test`) | **183/183 files, 996/996 tests passed** (incl. the new F-004 policy guard and the dye-purge test on PG)                                              |
| Backend, SQLite                                        | **172 passed, 10 skipped, 0 failed files · 950 passed, 42 skipped tests**                                                                            |
| Frontend + `packages/shared`                           | **92/92 files, 402/402 tests passed**                                                                                                                |
| `tsc --noEmit` root / backend · `typecheck:sqlite`     | 0 / 0 · passed (fingerprint unchanged)                                                                                                               |
| `npm run build` (frontend)                             | exit 0                                                                                                                                               |
| Root `npm run lint`                                    | 245 errors / 50 warnings — identical to the baseline (an intermediate run was 254/51 from my lines; fixed by hand / Prettier on files clean at HEAD) |
| Backend `npm run lint`                                 | exit 0                                                                                                                                               |

**Not run:** `cargo test`, browser e2e (TesterArmy/Playwright), multi-device harness — no Rust change;
they need a live stack. The Rust/DPAPI/factory-reset items of `remaining_work` were not examined.

## Owner decisions still open after both reports

M-02 per-currency day close · H-04 header discount on returns · S-02 / F-008 rounding · L-02 production
collation · H-05 remnant rule (implemented weight-only — confirm) · H-06 non-USD adjustment base ·
M-12 dependency upgrades · F-006 historical REAL migration (needs prod data) · C1-06 cross-currency
ranking · C1-12 which settings pages non-admins may open · F-002 a dedicated formatting commit.

---

# Round 3 — remaining items (backup/sync/reset/DPAPI, C1-06, C1-12, F-006, F-008, F-002)

Date: 2026-10-12 · Base `2b9b602c` + rounds 1–2 (uncommitted). Nothing committed, pushed or deployed.
Status words: **FIXED** (defect confirmed, fixed, test RED→GREEN) · **VERIFIED** (checked, sound, evidence
given) · **BLOCKED** (needs data/environment not available here) · **NEEDS DECISION** (owner choice).

## 1. Backup / restore / sync / factory reset / Rust-DPAPI

| ID                                                                                        | Status                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files                                   | Test                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R3-01 DPAPI second launch                                                                 | **FIXED**                         | `load_or_generate`: on a DPAPI/parse failure the store is renamed to `secrets.dat.corrupt-<ts>` and boot refuses — but the NEXT boot found no `secrets.dat` and silently generated new JWT/APP_MASTER_KEY (factory reset keeps secrets.dat, so this was the only path). Everything encrypted with the old master key (hub credentials, the `secrets` table) became unreadable and the Google token was lost. Now: no new keys while a preserved `.corrupt-*` exists unless `MOTARD_RESET_SECRETS=1` (the documented explicit consent); logic moved into `load_or_generate_at(path, reset_allowed)` / `persist_at` (public API unchanged). `SecretStore` deliberately has no `Debug` (secrets never reach a log) | `desktop/src-tauri/src/secret_store.rs` | `second_launch_after_preserved_corrupt_store_refuses_new_keys` — RED (guard disabled: panics "second launch must not generate new keys") → GREEN; secret_store 7/7 |
| R3-02 restore end-to-end                                                                  | **VERIFIED**                      | real v3 archive restored on disposable SQLite data; the live DB then carries the archive's data (`restore-path.test.ts`); RS-5 comparison, device-state carry-over, startup restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                       | `restore-path`, `restore-rs5`, `startup-restore`, `backup-v3` (in the 29-file run below)                                                                           |
| R3-03 interrupted restore                                                                 | **VERIFIED** (one gap noted)      | in-process failures: SWAP failure moves the set-aside files back; REOPEN failure restores the previous DB (`sqliteRestore.ts` SWAP/REOPEN catch blocks). A crash/power loss between the two renames leaves no `data\motard.db` → next boot sees prior-data evidence and stops at **DATA_MISSING** (restore / locate / start new) — never a silent empty start (`db_meta.rs`, test `data_missing_when_evidence_exists_without_a_database`); the old DB is in `set-aside\<ts>\`, plus the pre-restore safety backup. **Gap:** the boot does not auto-complete a half-done swap — operator recovery                                                                                                                | —                                       | Rust suite 105/105                                                                                                                                                 |
| R3-04 duplicate sync events / retries / conflicts / tombstones / claims / device identity | **VERIFIED**                      | rounds 1 (H-10/H-11) + existing suites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                       | 29 files / 234 passed, 1 skipped (list in Results)                                                                                                                 |
| R3-05 factory reset safety                                                                | **VERIFIED** + **NEEDS DECISION** | reset is two-phase (flag → archive on next boot, data renamed aside, hub pairing archived with it, secrets kept); typed phrase in the UI. Decisions: (a) it runs **from the login screen without a session** by design ("forgot the whole account"); the admin-only `/integrity/authorize-reset` flag is **not** checked by the Rust path; (b) `RESET_ARCHIVES_KEPT = 3`: a 4th reset **permanently deletes** the oldest `data.reset-*` (a complete earlier company DB) although the screen says "تُنقل جانباً ولا تُحذف". Both are deliberate (a Rust test asserts (b)), so not changed                                                                                                                        | —                                       | `stack.rs` tests                                                                                                                                                   |
| R3-06 desktop script gate                                                                 | **BLOCKED (environment)**         | 7 `server-bundle.test.mjs` tests need TCP 8080 free ("cannot bind decoy on 127.0.0.1:8080 EADDRINUSE"); 8080 is in use on this machine and is not stopped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                       | 24 pass / 7 fail (same before and after formatting)                                                                                                                |

## 2. C1-06 — debtors ordering — **NEEDS DECISION**

Traced: `reports.$slug.tsx` `PartyBalances` ← `GET /api/reports/party-balances` ← `partyBalances()` (both
engines): one row per party × currency, remaining = Σ(debit − credit) of active ledger legs (opening +
documents + payments), total/paid from invoices. Round 2 already orders SYP desc, then USD desc (no
conversion) and shows load errors. Ranking a SYP debtor against a USD debtor needs a rule:

1. **Per-currency tabs** (SYP list / USD list, each sorted by its own remaining) — no FX at all; recommended.
2. **Primary-currency order** (current): SYP first, USD as tie-break.
3. **Base-equivalent order** using each leg's frozen `base_debit/base_credit` (USD at the rate of each
   document) — needs agreement that the frozen base is the comparison basis.
4. A rate the operator enters for the report (display only).

## 3. C1-12 — settings permissions — **FIXED (settings area)** + **NEEDS DECISION (rest)**

Established roles (code): every settings write is admin-only on the server (`PUT /settings/:section`
`rbac(["admin"])`; users, invitations, backup, sync operator, Drive admin); settings/audit reads all
roles; `ROLE_ALLOWED_PATHS` grants `/settings` to admin only — but the pages opened by direct URL for any
role. Fix: `settings.tsx` layout denies by default (nothing until the role is known; non-admin →
denial); print-center hides its link to printing settings for non-admins.
Test: `src/routes/settings.access.test.ts` RED (1 failed at HEAD) → GREEN 2/2.
**Decisions needed:** (a) should non-admins see the **activity log** (backend allows audit reads for all
roles; the UI now hides it); (b) a **global route guard**: today `ROLE_ALLOWED_PATHS` only filters the
nav — by URL, warehouse can open `/cashbox`, `/customers`, `/invoices/…`, `/reports`; viewer `/cashbox`,
`/ledger`, `/invoices/…`. Enforcing the map on every route is deny-by-default but may break existing
deep links (e.g. inventory → invoice); confirm the map is the intended contract first.

## 4. F-006 — REAL money migration — **BLOCKED (needs a database copy)**

Evidence: before 0024 money was BIGINT whole units (no fractions existed); 0024 (2026-08-18) → `REAL`
(IEEE float32); 0026 (08-20) → BIGINT; 0036 (08-23) notes the live DB never got 0026 and converts
REAL→BIGINT; 0037 → NUMERIC(14,2). Simulation (float32 round-trip, `scratchpad/f008/f006.mjs`):
≤ 16,777,216 exact; 16.7M–33.5M: 50% of amounts change (±1 SYP); 33.5M–67M 75% (±2); 67M–134M
87.5% (±4); 134M–268M 93.7% (±8); 268M–1.07B 100% (±31); 1.07B–4.3B 100% (±127); e.g.
125,750,500 → 125,750,496; 2,500,500,000 → 2,500,499,968. Fractions written during the REAL window
became whole units. **Not affected:** the desktop SQLite engine (own 6-file migration set) and any PG
database created after 0037 (migrations ran on empty tables).
**Needed to close it:** a copy (snapshot or anonymised) of any PostgreSQL database that held data between
2026-08-18 and 2026-08-23 (the retired desktop `pgdata`, or the hub if it pre-dates that window), to run
read-only: (1) `invoices.total` vs Σ line nets − discount + tax + shipping; (2) per document Σ ledger
debit vs credit and vs `invoices.total`; (3) amounts > 16,777,216 that sit on a float32 grid point.
Production data is never modified.

## 5. F-008 — rounding — **NEEDS DECISION** (measured, no behaviour changed)

`round2dp` (JS float, `Math.round`) vs exact decimal half-away-from-zero (PG `ROUND`, SQLite twin's
`roundDiv`/`pgNumericDivide`), script `scratchpad/f008/rounding.mjs`:
qty×price 2dp×2dp: 246/35,000 (0.70%) differ · returns 2dp×4dp: 3/25,000 · **negatives: 528/4,000
(13.2%)** (`Math.round(-x.5)` rounds toward +∞) · SYP÷rate: 1/8,024 · USD×rate: 400/8,574 (4.7%) ·
large SYP / gross−discount: 0. Max 1 cent everywhere. Cross-layer case: a return's ledger credit is
JS `round2dp(q×p)` while invoice "remaining"/customer-credit use SQL `ROUND(q×p,2)` → can differ by 0.01.
**Recommended single policy:** exact decimal **half away from zero** at 2 dp everywhere (= PostgreSQL and
the SQLite twin today), JS side implemented by rounding the 15-significant-digit decimal string (no
float multiply). Candidate B (`scratchpad/f008/candidateB.mjs`): **0 differences in all ~98k cases**
(a simpler `toPrecision`+`Math.round` candidate still differed 1.5% on ×rate). Applying it changes some
totals by one cent → needs approval and a reconciliation pass.

## 6. F-002 — formatting — **FIXED** (separate pass, no logic change)

- `npx prettier --check .`: **823** files before. Formatted **743** (742 actually changed); left
  unformatted on purpose: the 4 audit artefacts (`CODEBASE_AUDIT_REPORT*.md`, the Hermes JSON,
  `AUDIT_PROGRESS.md` — preserved verbatim) and **94** `backend/src/infrastructure/orm/**` files
  (generated SQLite schema "Do not edit by hand", migration meta JSON, and PG schema sources the
  generator parses with single-line regexes). After: 98 left = exactly those.
- Separation: the functional diff was saved before formatting (`scratchpad/f002/functional-tracked.patch`,
  untracked list) and every formatted file backed up (`scratchpad/f002/backup/`).
- Proof of no logic change: 691 files equal after whitespace/comma/quote normalisation; of the 51 left,
  27 code files emit **identical JavaScript** (TypeScript transpile), 8 differ only by JSX whitespace
  made explicit (`{" "}`) or array/chain wrapping, 6 are HTML/Markdown layout.
- Lint: root went from 245 errors / 50 warnings to **0 errors / 50 warnings — exit 0 (gate passes)**;
  the one non-format error (pre-existing `rules-of-hooks` in `useOrders.test.tsx`, which calls the hook
  with a mocked `useQuery` on purpose) got a scoped `eslint-disable` with the reason.

## Results (actual runs, round 3)

| Check                                                               | Result                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Rust `cargo test --lib` (`-j1`)                                     | **105/105 passed** (incl. the new DPAPI test)                                                        |
| Backup/restore/sync subset, SQLite (29 files)                       | **234 passed, 1 skipped**                                                                            |
| Frontend + shared (after formatting)                                | **93/93 files, 404/404 tests**                                                                       |
| Backend SQLite full (after formatting)                              | **172 passed, 10 skipped, 0 failed files · 950 passed, 42 skipped** (identical to before formatting) |
| `tsc` root / backend · `typecheck:sqlite` (generator + fingerprint) | 0 / 0 · passed                                                                                       |
| Root lint / backend lint / build / admin tsc                        | exit 0 / 0 / 0 / 0                                                                                   |
| Desktop script tests                                                | 24 pass, 7 fail = port 8080 busy (BLOCKED, environment)                                              |
| Backend PostgreSQL 17 full (after formatting, disposable :56437)    | **183/183 files, 996/996 tests**                                                                     |

---

# Round 4 — owner decisions applied (2026-10-12)

## R3-05(b) Reset archives — **FIXED** (owner: keep every archive, never delete)

`move_data_aside` no longer deletes `data.reset-*` archives (the `RESET_ARCHIVES_KEPT = 3` cap is
removed). Test `factory_reset_keeps_only_newest_archives` → `factory_reset_never_deletes_earlier_archives`
(asserts all 4 archives remain, the oldest included). Rust: 2/2 reset tests pass. RED against the old
code was not executed (the old code deleted by design; the test inverts that assertion).
File: `desktop/src-tauri/src/runtime/stack.rs`.

## F-008 Rounding — **FIXED** (policy adopted after measuring; owner priority)

**Root causes found**

- RC1 — JS rounded the binary float, not the decimal: `0.18 × 1.25 = 0.22499999999999998 → 0.22`
  (correct 0.23); `Math.round(−2.5) = −2`. The database layer (PG `ROUND`, SQLite `roundDiv` /
  `pgNumericDivide`) was already exact half-away-from-zero.
- RC2 — the same value is POSTED by JS and RE-COMPUTED by SQL: a return's ledger credit is JS
  `round2dp(q×p)` while invoice "remaining" (voucher guard), customer credit, profit and dashboards
  use SQL `ROUND(q×p, 2)`. When RC1 strikes, a fully returned invoice shows ±0.01 forever.
- Rust does no money arithmetic (shell/process/file code only) — nothing to unify there.

**Measured impact (before the change)**

- Real code path, both engines' SQL forms, 12 half-cent cases: **5/12** returned lines posted a credit
  1 cent below the SQL value (e.g. 0.22 vs 0.23) — `backend/tests/rounding-cross-layer.test.ts` RED.
- Sell → pay exact total → return half, 12 cases: posted return credits **79.83** vs SQL **79.88**
  (5 cents of drift between the ledger and the invoice view) — same test, RED.
- 5-year simulation (150,000 lines, realistic USD/SYP mix, `scratchpad/f008/cumulative.mjs`):
  SYP lines with whole-lira prices 0/89,979 affected (lira × 2-dp kg never makes a half cent);
  USD lines 0.35% off by 1 cent, **always downward** (systematic under-billing, −$2.12 over 5 years);
  26/4,836 fully returned USD lines leave a stranded cent; USD→SYP conversions 0.27%; negative amounts
  2.5%. Ledger stays balanced per document (no trial-balance error); the harm is wrong-by-a-cent values
  and irreconcilable views, which compound in count, not in size.
- **Effect on existing data: none.** Read-only copies of the live DB and both reset archives (copied
  with the SQLite backup API from a read-only connection, analysed, then deleted; counts only):
  0/22 invoices, 0/22 lines, 0/4 returns, 0 cross-currency settlements would compute differently, and
  every stored invoice total matches a recomputation exactly (`scratchpad/f008/impact.cjs`).

**Fix (one policy, everywhere):** `round2dp` / `round4dp` = exact decimal, half away from zero, on
the value's 15-significant-digit decimal string (money columns hold ≤ 12 integer digits, so the
deciding digit is always present) — `packages/shared/src/precision.ts` (`roundDecimal`). The frontend
re-exports the same helper, so web, desktop and both engines now agree with the database. Also: the
statement's derived price-per-kg (`amount ÷ qty`, both engines) and `DualCurrency` display use the
helper instead of `Math.round(x*100)/100`. Other `Math.round(x*100)/100` sites round sums/differences
of 2-dp values (kg, balances) where no half cent can arise — unchanged.

**Tests**

- `packages/shared/src/precision.test.ts` (+6): half cents, negatives (away from zero, never −0),
  large SYP (999,999,999,999.995 → 1,000,000,000,000), non-finite, round4dp, and an exhaustive grid
  (qty×price 2dp/4dp ± , USD×rate, SYP÷rate) against BigInt ground truth — RED 4 failing on the old
  rule → GREEN 9/9.
- `backend/tests/rounding-cross-layer.test.ts` (2, engine-agnostic): RED 2/2 on the old rule → GREEN.

**Rollout note:** the hub recomputes synced invoices from `createInput`, so the hub (Render) and all
desktops must run the same version; otherwise a half-cent line could total differently on hub and
device. Residual: hub data posted before the change is not visible here — before deploying, run the
same `impact.cjs` style count read-only on a hub snapshot (any half-cent USD line returned after the
upgrade would credit 1 cent more than its legacy posted total).

## Permissions — second admin **VERIFIED**; flexible permissions **design pending**

A second admin already works: `/settings/users` (round 2) sets any other user's role to admin via
`PATCH /users/:id`; the server refuses self-demotion/self-deactivation, so one admin always remains.
Per-user grants for accountants are a new subsystem → design question sent to the owner first.

## Results (actual runs, round 4)

| Check                                          | Result                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Backend PostgreSQL 17 full (disposable :56437) | **184/184 files, 998/998 tests**                                          |
| Backend SQLite full                            | **173 passed, 10 skipped, 0 failed files · 952 passed, 42 skipped**       |
| Frontend + shared                              | **93/93 files, 410/410 tests**                                            |
| Rust reset tests                               | 2/2 (full Rust suite last run: 105/105, before this round's reset change) |
| `tsc` root / backend · root lint               | 0 / 0 · 0 errors / 50 warnings (exit 0)                                   |

---

# Round 5 — simplified permission model (2026-10-12, owner decision)

**Decision (owner):** the accountant can do everything the admin can (accounting, invoices,
warehouses, cashbox, reports, settings, users, backup/restore, sync, Drive, licence, integrity), except
the admin role itself: it cannot grant the admin role, cannot touch an admin account, and cannot change
its own role. Invitations: the owner's two messages differed ("لا يستطيع إنشاء رمز دعوة" vs "بيقدر إنشاء
الدعوات"); implemented the last summary ("يعمل كل شيء بدون إزالة مدير"): the accountant **may** invite,
but **never into the admin role**. The stricter reading (no invitations at all) is a one-line change in
`invitation.route.ts`.

**FIXED**
- `rbac.middleware.ts`: a guard that allows `"admin"` also allows the accountant (≈40 guards in
  `server.ts` + route files: settings, users, invitations, backup, sync operator, Drive, licence,
  company, health, year reopen, fabric/colour/roll/print writes). New `hasAdminPrivileges(role)`
  replaces the inline `userRole !== "admin"` checks in `backup.route.ts` (4) and `integrity.route.ts` (2).
  `hubConfig.ts` already accepted admin/accountant.
- `user.route.ts`: a non-admin cannot set `role: "admin"`, cannot PATCH/DELETE/reset-password an admin
  account (`403 ADMIN_ROLE_RESERVED`); **nobody** changes their own role (`400 SELF_ROLE_CHANGE`).
  **Correction to round 4:** round 4 said the server refused self-demotion — it did not (only
  self-deactivation/deletion). An admin could demote themselves and leave the company with no admin;
  now refused.
- `invitation.route.ts`: a non-admin cannot mint a `user` invitation with `targetRole: "admin"`
  (the UI never offered it; the server now enforces it).
- Frontend: `ROLE_ALLOWED_PATHS.accountant = ["*"]`; `hasAdminPrivileges` in `useSettings.ts`, used
  by the settings layout, users, sync (incl. hub devices card), print-centre; in the users page the
  admin option and admin rows are disabled for a non-admin. Role matrix text updated.
- `src/contracts/*.ts` `auth.roles` lists are documentation only (no code reads them) — left as they
  were; the effective rule is the rbac middleware.

**Rollout:** the hub applies its own rbac — an accountant's hub credentials gain the new rights only
once the hub runs this version.

**Tests**
- `backend/tests/accountant-admin-privileges.test.ts` (6, engine-agnostic, real rbac + real routes):
  RED against HEAD 4/6 failed → GREEN 6/6.
- Updated for the new rule (deny side kept with warehouse/viewer): `src/routes/settings.access.test.ts`,
  `backend/tests/drive-route.test.ts`, `backend/tests/sqlite/backup-route-desktop.test.ts`.

**Results (actual runs, round 5)**
| Check | Result |
| --- | --- |
| Frontend + shared | **93/93 files, 410/410 tests** |
| Backend SQLite full | **174 passed, 10 skipped files** (after updating the 2 old-rule tests) |
| Backend PostgreSQL 17 full (disposable :56437, stopped after) | **185/185 files, 1004/1004 tests** |
| `tsc` root / backend · root lint · build | 0 / 0 · 0 errors / 50 warnings · exit 0 |
