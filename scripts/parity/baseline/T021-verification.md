# T021 — D-4 baseline fix verification

## D-4 baseline fix: commit `d8608ac3` (2026-10-05)

Per the owner's decision of 2026-10-05, the commit contains **only** the approved D-4 change. Each file was built from
its pre-fix (`7d2ffd1f`) version plus the D-4 edits alone. None of the uncommitted SQLite or other work-in-progress
went in, and the working tree was not modified.

| File | D-4 content |
|---|---|
| `backend/src/infrastructure/repositories/PostgresPartyRepository.ts` | `list()` excludes `status='cancelled'` unless a status filter is given (`ne` import) |
| `src/presentation/hooks/useParties.ts` | operational caches exclude cancelled; history-only cancelled cache keeps `customerById`/`supplierById` resolving |
| `backend/tests/cancelled-records-lists.test.ts` | 6 PostgreSQL tests (lists, total, explicit filter, by-id) |
| `src/presentation/hooks/__tests__/useParties.cancelled.test.ts` | 2 tests (cache split, explicit status filter) |

Verified in a worktree of `7d2ffd1f` with exactly these four files applied:

- frontend `src/presentation/hooks`: 16/16 tests pass;
- `tsc --noEmit` exits 0;
- backend D-4 and party tests on PostgreSQL 17.10: 14/14 pass.

## Cloud image (2026-10-05): **builds and serves; D-4 verified through it**

The cause was a build-infrastructure defect that predates D-4. Since the backend began importing `@erp/shared`
(`../packages/shared`, tsconfig `rootDir ".."`), `docker build backend/` could not see the shared package. Fix,
build files only, no product code:

- `backend/Dockerfile`: build context is the repository root; the image mirrors the repo layout
  (`/repo/backend` + `/repo/packages/shared`; `/repo/node_modules` → backend `node_modules` for the shared package's
  `zod`); `CMD dist/backend/src/presentation/server.js`, the real `tsc` output path.
- `backend/Dockerfile.dockerignore`: sends only `backend/` and `packages/shared/`, and leaves out colocated
  `*.test.ts` files (they import the root-workspace `vitest`; they are not part of the image).
- `backend/docker-compose.yml`: `context: ..`, `dockerfile: backend/Dockerfile`; dev mount moved to `/repo/backend/src`.

Proof:

- `docker build -f backend/Dockerfile -t motard-backend:t021 .` → success.
- The image was run in production mode (`NODE_ENV=production`, with the required `SETUP_TOKEN`, `REDIS_URL` and
  license keys) against `postgres:17-alpine` + `redis:7-alpine`. `/api/health/live` returned `ok`, and
  `/api/health/ready` returned `{"database":true,"redis":true}`.
- D-4 through the image's real API: the default `GET /api/customers` contains the active customer and **not** the
  cancelled one; `?status=cancelled` returns it; `GET /api/customers/:id` of the cancelled one answers 200
  `status=cancelled`.

## Certification e2e (`cert-ui` + `cert-financial`), 2026-10-05

The suites could not run at all for three test-infrastructure reasons, all fixed:

1. `tests/e2e/playwright.cert.config.ts` resolved `testDir` relative to its own folder twice (`./tests/e2e/cert-*`
   inside `tests/e2e/`), so Playwright reported "No tests found". Changed to `./cert-*`.
2. `tests/e2e/_helpers/login.ts` filled an email/password form that no longer exists (the login screen is the PIN user
   picker). It now signs in through the real `POST /api/auth/login` and hands the issued session to the page the way
   the app stores it (TokenProvider keys).
3. `tests/e2e/_helpers/mock-data.ts` posted to `/suppliers`, `/customers`, … (404); the API lives under `/api/…`.

There is also a new disposable stack, `tests/e2e/cert-stack.mjs`. It:

- creates a migrated `erp_cert` database on the 55432 cluster;
- seeds a licensed tenant and the E2E admin (Argon2id, `E2E_ADMIN_PASSWORD`);
- starts the backend on :8080 and the UI on :8081 with the UI's existing `VITE_ACTIVATION_BYPASS=1`, because licence
  activation is outside these suites;
- takes `--root <checkout>` to serve another commit.

Results:

| Stack | passed | failed | skipped |
|---|---|---|---|
| post-fix (current tree, D-4 committed) | 56 | 34 | 4 |
| **pre-fix** (`7d2ffd1f` worktree) | 56 | 34 | 4 |

**The two failure sets are identical** (same 34 tests, compared by name). So the D-4 fix changes nothing these suites
observe, and the 34 failures predate it. They are stale assertions in the suites themselves:

- button and dialog labels, a hard-coded `/invoices/INV-2863`, `window.print` hooks;
- financial API fields such as `remainingKg`, and creations missing now-required fields.

By spec: button-audit 14, dialog-audit 7, stress-test 4, math-verify 3, print-cert 3, print-export 2, form-audit 1.
Rewriting them is suite-content work outside the owner-approved scope (test/build infrastructure only), so they were
left as they are.

## Re-run 2026-10-04 (current working tree, PostgreSQL 17 throwaway cluster on 55432)

| Check | Result |## Re-run 2026-10-04 (current working tree, PostgreSQL 17 throwaway cluster on 55432)

| Check | Result |
|---|---|
| Backend suite on PostgreSQL (`npm test`) | **PASS** — 134 files / 773 tests after one fix: `sync-coverage` flagged two new US3/US4 endpoints (`POST /api/desktop/runtime/pre-update-backup`, `POST /api/desktop/runtime/shutdown`) missing from `SYNC_COVERAGE`; both registered as device-local exemptions (re-run 5/5) |
| Frontend suite (`npx vitest run`) | **PASS except 1 pre-existing** — 275/276. `dfp029-credentials` reads `README.md`, which the working tree deletes (not this feature). `UserPickerPage.test.ts` timed out once under parallel load and passed 3/3 on its own |
| Typecheck root + backend (`tsc --noEmit`) | **PASS** — both exit 0 |
| Cloud-behavior diff (parity scenarios 01–14 over HTTP, PostgreSQL) | see below |
| Cloud image `docker build backend/` | **BLOCKED — pre-existing** build-context defect (`@erp/shared` lives in `packages/shared`, outside the `backend/` context). Unchanged since 2026-10-03; the Dockerfile is untouched by this feature. Docker daemon also not running on this machine |
| e2e `cert-financial` / `cert-ui` | **NOT RUNNABLE — pre-existing stale suite**: `tests/e2e/_helpers/login.ts` waits for an email input (`input[type="email"]` / placeholder `admin@erp.local`), but the login screen at HEAD and in the working tree is the PIN user picker (`UserPickerPage`), which has no email field. The suites cannot log in against either the pre-fix or the fixed build; last edited 2026-09-20 |
| Commit hash "D-4 baseline fix" | **NOT RECORDED** — the D-4 fix and the whole feature are uncommitted on `clean-desktop-release`; a commit needs the owner's go-ahead |

### Cloud-behavior diff

The diff used the parity harness instead of the Playwright suites, since those can't log in (see above).

1. **Current tree (PG) vs the frozen T026 reference output** (`scripts/parity/out/pg`):
   `[parity:diff] PASS — empty diff across 67 file(s)`.
2. **Pre-fix HEAD `7d2ffd1f` (PG) vs the current tree (PG).** HEAD was bundled with `desktop/scripts/bundle-server.mjs` in a
   temporary worktree. HEAD does not build alone, because the old unanchored `.gitignore` rule `backup/` kept
   `backend/src/infrastructure/backup/*` out of git. So `backupError.ts`, `backupScheduler.ts`, `portableBackup.ts` and
   `orm/pgLazy.ts` were copied in from the working tree; they only serve backup routes. Every difference is classified:

   | Scenario step | Difference | Cause |
   |---|---|---|
   | 07 `customer.list.after-delete` | the cancelled customer is absent; total 4 → 3 | **D-4** (the intended change) |
   | 07 `party.delete.with-history.rejected` | message now names the blocking invoice | party deletion-impact work that predates this feature and is uncommitted (`purgePartyCascadeUseCase`) |
   | 11 `purge.party.cascade` and the lists after it | 422 → 204, then cascaded statuses | same: party cascade purge, uncommitted, pre-existing |
   | 11 `dye.*` | 404 → 200/400 | dye purge (`dye.route.ts`, untracked, pre-existing) |
   | 08 `[30]`, `[31]`; 09 all | 404 → 200 | year closing and inventory counts (`year-closing.route.ts`, untracked, pre-existing) |
   | 10 all | id offsets only (`#00196` → `#00201`) | earlier scenarios create more rows on the fixed build |

   T015 (2026-10-03, before any engine work) already lists `dye.route`, `year-closing.route` and
   `purgePartyCascadeUseCase`, so these are existing uncommitted product features, not engine-change side effects. Among
   list endpoints, D-4 is the only behavior change.

Status (superseded 2026-10-05): see the sections above — the commit, the cloud image and the e2e comparison are complete.

## Original run 2026-10-03

| Check | Result |
|---|---|
| Backend suite on PostgreSQL 17.10 | PASS — 114 files / 652 tests (6 new D-4 tests) |
| Frontend suite | PASS except 1 pre-existing (`dfp029-credentials`, README.md deleted) |
| Typecheck / production build | PASS after adding `openingDate`/`openingNote` to `createPartyData`'s input type |
| Cloud image `npm ci` | PASS after moving `better-sqlite3` to `optionalDependencies` (Alpine node-gyp failure; the cloud never loads it) |
| Cloud image `npm run build` | BLOCKED — pre-existing `@erp/shared` build-context defect |
