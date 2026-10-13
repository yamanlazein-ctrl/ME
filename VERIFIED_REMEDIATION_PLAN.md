# Verified remediation plan — 2026-10-12

Sources (read in full; preserved unchanged): `1/1.json` (current audit ERP-20261012-95f3568b: findings,
checks, prior rechecks, style observations), `1/2.md` (historical 31-finding report H-/M-/L-/S-, appendices of
raw diagnostics, §13 F-011, and the current audit checkpoints A1–C1), `1/3.md` (current audit progress),
`1/aduite-12.md` (Hermes session, items 1–11).

Baseline: branch `main`, HEAD `a3882558` (owner commit `7eaabec1` + merge). Working tree at start: only
`CODEBASE_AUDIT_REPORT.md` modified and two untracked audit files (all preserved). Nothing is committed,
pushed or deployed by this work.

Status words: **Confirmed** (reproduced in the current code) · **Already Fixed** (fixed earlier; the
regression test was re-run on the current code) · **Not Reproducible** · **Invalid** · **Blocked**
(needs data, environment or an owner decision). After the work: **FIXED** (RED→GREEN test) or the reason
it is not.

## 1. Verification of every reported issue

### 1a. Current audit (`1/1.json`, `1/2.md` §Current audit, `1/3.md`)

| ID | Sev. | Verdict | Evidence in the current code |
|---|---|---|---|
| ERP-001 | High | **Confirmed** | `PostgresUserRepository.update` / `SqliteUserRepository.update` call `invalidateIdentityCache` only when `active === false`; `sessionCutoff.ts` serves a cached role for 60 s. Also found: the sync path `syncMaterialize.materializeUser` (user snapshot from a peer) never invalidates. |
| ERP-002 | High | **Confirmed** | `user.route.ts` PATCH/DELETE/reset-password: write, then snapshot + enqueue as separate steps; containers wire `userRepo` with the raw `db`, not the ambient `dbx` the outbox uses, so even a wrapping transaction would not include it. `invitation.route.ts` consume: user created before its enqueue. |
| ERP-003 | Low | **Confirmed** | `InvitationManager.tsx`: five `<Label>`s without `htmlFor`/ids. |
| ERP-004 | Low | **Confirmed** | `accountant-admin-privileges.test.ts`: mock repo has no `list`; GET /users asserted only `not 403` (handler returns 500). |
| ERP-005 | High (conditional) | **Confirmed (source)** | `admin-dashboard/vite.config.ts` `host: true` + `/license-admin` proxy → the license server sees a loopback socket; `super-admin-auth.middleware.ts` grants `super_admin` with no credential to any loopback socket when `openLoopback` (default outside production). |
| ERP-006 | Medium | **Confirmed** | `ApiVoucherRepository.findById` tries `/payments/:id` first; backend `/payments/:id` returns any voucher by id; `paymentToVoucher` hard-codes `kind: payment`, `partyKind: supplier` although the DTO carries `kind`/`partyKind`. |
| ERP-007 | High | **Confirmed** | `CancelVoucherUseCase`/`CancelReturnUseCase` call `ledger.cancelByReference` after the server cancel; `ApiLedgerRepository.cancelByReference` always throws; container wires exactly that adapter. |
| ERP-008 | High | **Confirmed** | `VoucherForm.save`: cancel (own transaction) then create (separate request); a failed create leaves the original cancelled. No replace endpoint. |
| Prior H-09 / H-01 / admin lock | — | **Already Fixed** | see 1b (regression tests pass). |
| STYLE-001/002 | Info | **Invalid as defects** | `0023_…sql` one trailing space in an applied migration (editing applied migrations changes checksums — left); a CRLF `.sql` research appendix under `specs/` (not executed). |

### 1b. Historical report (`1/2.md` lines 1–1036, §13)

All were remediated in rounds 1–2 (`CODEBASE_REMEDIATION_LOG.md`). Re-verified **today on the current code**:
regression files for H-01..H-13, M-01, M-03, M-04, M-13, S-02/F-008 — 12 files / 46 tests pass (SQLite);
config items checked at source (M-07 `cd backend`, M-08 `testDir: "."`, M-10 interpolation + `APP_MASTER_KEY`,
L-01 `SQLITE_PATH` layout, L-03 `htmlFor`, L-04 locks tracked, L-05 fail-on-error, F-011 `HeaderField`/`CardField`
take `htmlFor`). Verdict: **Already Fixed**, except the owner-decision items below which stay **Blocked**:
M-02 (per-currency day close), H-04 header discount on returns, M-12 remaining advisories (major upgrades),
L-02 production collation, F-006 (needs a database copy from 2026-08-18..23).

### 1c. Hermes session (`1/aduite-12.md`)

| # | ID | Verdict | Evidence |
|---|---|---|---|
| 1 | TEMP-STAT-02 twin drift | **Confirmed (tooling)** | `port-sqlite-repos.mjs --check` → 47 drift lines today. Behaviour net: both-engine suites green. |
| 2 | TEMP-STAT-01 prettier | **Confirmed** | `prettier --check .` → 101 files: 76 under `backend/src/infrastructure/orm/**` (generator inputs/outputs, deliberately unformatted), 7 audit artefacts (preserved verbatim), **18 source/test files** drifted after the F-002 pass; no CI step. |
| 3 | TEMP-SYNC-01 polling | **Confirmed** | `useAutoSync` periodic tick every 5 s with no backoff when the hub refuses the device (`deviceGate`) or the run fails. |
| 4 | TEMP-SYNC-02 harness | **Confirmed (documented in CI)** | advisory step, template reuse. |
| 5 | TEMP-DB-01 pgRef | **Confirmed** | SQLite journal `0005_drive_archive` `pgReferenceJournalIdx: 101`; it mirrors PG idx 102 (`0005_drive_archive.sql:80-84`). Field is informational (no code reads it). |
| 6 | stale installer | **Blocked** | release action (version bump + build + owner install) — not a code defect. |
| 7 | uninstall keeps data | **Blocked (decision)** | by design (`hooks.nsh`); UI wording/data-generation screen is a product decision. |
| 8 | build tree size | **Blocked (owner)** | deleting build artefacts/old installers is the owner's call; no code defect. |
| 9 | no 4xx/5xx logging | **Confirmed** | to verify in `server.ts` request logging. |
| 10–11 | "not a problem" items | **Invalid as defects** | the session itself disproved them. |

### 1d. Newly discovered

| ID | Sev. | Verdict | Evidence |
|---|---|---|---|
| NEW-01 | High | **Confirmed (source)** | Hub `materializeUser` (inbox path, `tryMaterializeAcceptedUnit`) upserts role/password hash from the pushed snapshot with no check of the pushing user's role. The sync transport admits admin **and accountant** (`transportGuard: rbac(["admin","accountant"])`), so an accountant session could push a user unit granting itself admin or replacing an admin's password hash — bypassing `ADMIN_ROLE_RESERVED` (round 5). Pull path (`hubCanonical`) is trusted hub data. |

## 2. Execution order (security → integrity → financial → functionality → reliability → quality)

| # | Issue | Safest correction | Regression test |
|---|---|---|---|
| 1 | NEW-01 | hub inbox path only: a non-admin pusher's user unit that sets `role: admin` or changes an existing admin row is parked `invalid` (not applied); store gains `findUserRole` on both engines | engine-agnostic materialize test |
| 2 | ERP-001 | invalidate the identity cache after every successful user update (both engines) and after a sync user upsert | real cache + repo: demote → next resolve returns the new role |
| 3 | ERP-005 | dashboard dev server binds loopback by default; proxy forwards `X-Forwarded-For`; open-loopback bypass refused when a forwarded hop is non-loopback | middleware test |
| 4 | ERP-002 | `userRepo` on the ambient `dbx` (both containers); route write + snapshot + enqueue in one `withTenantTx`; session cutoff after commit; invitation consume + enqueue in one transaction | failing outbox → nothing persisted |
| 5 | ERP-007 | cancel use cases drop the client-side ledger call (backend owns reversal, as `CancelInvoiceUseCase`) | real `ApiLedgerRepository` wiring resolves |
| 6 | ERP-006 | mappers keep the DTO's `kind`/`partyKind` | receipt via /payments/:id stays receipt |
| 7 | ERP-008 | backend `POST /payments/:id/replace` + `/receipts/:id/replace`: validate, cancel (version-checked) + create + both outbox units in ONE transaction, rollback on any refusal; form uses it | failing replacement → original still active |
| 8 | TEMP-SYNC-01 | exponential backoff (5 s → 5 min) on device refusal / failure, reset on success | pure backoff test |
| 9 | ERP-004, ERP-003 | faithful mock + exact 200; label ids | updated tests |
| 10 | TEMP-DB-01, TEMP-STAT-01 | pgRef 102; format the 18 drifted files; `.prettierignore` for generator files + audit artefacts; CI `prettier --check` | `prettier --check .` exit 0 |
| 11 | #9 logging, TEMP-STAT-02, TEMP-SYNC-02 | investigate; fix what is safe | — |

## 3. Execution log

(appended below as each item is done)

### NEW-01 — FIXED
- Files: `syncMaterialize.ts` (`materializeUser` gets `meta`; hub inbox path refuses a non-admin pusher's unit
  that sets `role: admin` or targets an admin row → `invalid`, parked, not applied; all of it inside the
  existing `try` so a DB error stays retryable `failed`), `ISyncMaterializeStore.ts` + `PostgresSyncMaterializeStore.ts`
  + `SqliteSyncMaterializeStore.ts` (`findUserRole`).
- Test: `backend/tests/sync-user-admin-reserved.test.ts` (3) — RED against HEAD 2/3 failed → GREEN 3/3 (SQLite).
- Residual: an admin's own edit pushed later under an accountant session is parked (visible) instead of
  applied; the admin re-saves it. Accepted: security first, never silent.

### ERP-001 — FIXED
- Files: `PostgresUserRepository.ts`, `sqlite/SqliteUserRepository.ts` (invalidate on every update);
  `syncMaterialize.ts` (invalidate after a synced user upsert); `user.route.ts` (again after commit).
- Test: `backend/tests/user-role-change-revokes-cache.test.ts` — RED against HEAD (SQLite twin) 1/1 failed → GREEN.
  Sync path covered by `sync-user-admin-reserved.test.ts` case 2.
- Residual: the cache is per process; the hub and each desktop run one API process each, so per-process
  invalidation is complete for the current deployment. A multi-replica hub would need shared invalidation.

### ERP-005 — FIXED
- Files: `super-admin-auth.middleware.ts` (open loopback only when the SOCKET is loopback and every
  `X-Forwarded-For` / `Forwarded` hop is loopback; `req.ip` alone no longer counts), `admin-dashboard/vite.config.ts`
  (binds `127.0.0.1` unless `ADMIN_DASHBOARD_HOST` is set; proxy `xfwd: true`).
- Test: `backend/tests/super-admin-loopback-proxy.test.ts` (3) — RED 2/3 failed → GREEN; `dfp030-loopback-bind` still passes.
- Not executed: a live Vite proxy run (admin dashboard dev stack not started).

### ERP-002 — FIXED
- Files: `postgresContainer.ts`, `sqliteContainer.ts` (`userRepo` on `dbx`), `user.route.ts`
  (`writeAndEnqueue`: write + snapshot + enqueue in one `withTenantTx`; session cutoff after commit),
  `invitationUseCases.ts` (`afterRedeem` hook inside the redeem transaction), `invitation.route.ts` (enqueue via the hook).
- Tests: `backend/tests/user-mutation-outbox-atomic.test.ts` (2, real container repo) — RED against HEAD 1/2
  failed → GREEN 2/2 (SQLite); `invitation-atomic-live.test.ts` + 1 case (PostgreSQL-only file; run in the PG suite).
- Note: during the RED run the scratchpad backup folder had been removed from %TEMP% outside this session, so the
  three route/container files were reset to HEAD by the RED step; the edits were re-applied from the same script
  and re-verified (10/10). No other file was affected (checked).

### ERP-007 — FIXED
- Files: `CancelVoucherUseCase.ts`, `CancelReturnUseCase.ts` (no client-side ledger call; the server cancel
  reverses ledger/stock/paid in its transaction — checked in `PostgresReturnRepository.cancel` and the voucher
  cancel route), `container.ts` wiring.
- Test: `src/application/__tests__/cancel-return-ledger.test.ts` rewritten (3) with the REAL `ApiLedgerRepository`
  — RED against HEAD 2/3 failed → GREEN 3/3.

### ERP-006 — FIXED
- Files: `ApiVoucherRepository.ts` (mappers keep the DTO's `kind`/`partyKind`), `contracts/payments.ts`,
  `contracts/receipts.ts` (declare the fields the server already returns).
- Test: `src/infrastructure/repositories/api/ApiVoucherRepository.kind.test.ts` (2) — RED 1/2 failed → GREEN.

### ERP-008 — FIXED
- Files: `voucher.route.ts` (`POST /payments/:id/replace`, `POST /receipts/:id/replace`: idempotency required,
  body `{expectedVersion, voucher}` schema-validated before any write, original kind must match the path; cancel
  (version-checked) + cancel outbox unit + create + create outbox unit in ONE `withTenantTx`; any refusal throws
  → full rollback, 422), `syncCoverage.ts` (both endpoints registered), `VoucherApiService.ts`,
  `ApiVoucherRepository.replace`, `useVouchers.ts` (`useReplaceVoucher`), `VoucherForm.tsx` (amend uses it).
- Test: `backend/tests/voucher-replace-atomic.test.ts` (3, real engine repos + route): unknown party and stale
  version leave the original ACTIVE; valid amend cancels + creates; kind mismatch refused. RED (endpoint absent
  at HEAD) 3/3 failed → GREEN 3/3.
- Hub replay: the two outbox units replay in order (cancel then create) like separate requests did.

### TEMP-SYNC-01 — FIXED
- File: `useAutoSync.ts` — periodic tick backs off 10 s → … → 5 min (cap) after a device refusal
  (`deviceGate`), a pull error or an exception; resets on the first clean run.
- Test: `src/presentation/hooks/__tests__/useAutoSync.backoff.test.ts` (2): cadence + a simulated day of refusals
  < 300 calls (was ~17,000). Not executed: a live revoked device for 10 minutes.

### ERP-004 — FIXED · ERP-003 — FIXED
- `accountant-admin-privileges.test.ts`: mock gets `list`, GET /users asserted exactly 200 (6/6).
- `InvitationManager.tsx`: five labels tied to controls (`useId`-based ids, `SelectTrigger id`);
  `settings.labels.test.ts` now also scans InvitationManager — RED 1 failed → GREEN 13/13.

### TEMP-DB-01 — FIXED
- `orm/sqlite/migrations/meta/_journal.json` `0005_drive_archive.pgReferenceJournalIdx` 101 → 102
  (informational field; no code reads it). `npm run typecheck:sqlite` passes.

### TEMP-STAT-01 — FIXED
- Formatted the 17 drifted source/test files (format-only); `.prettierignore` now lists the generator-owned
  `backend/src/infrastructure/orm/` tree and the audit/remediation records (kept verbatim);
  CI step `npx prettier --check .` after Lint. `npx prettier --check .` → "All matched files use Prettier code
  style!"; `dfp008-ci-gates.test.mjs` 3/3.

### aduite-12 #9 (failed-request logging) — FIXED
- New `failed-response-log.middleware.ts`, mounted in `server.ts`: every 4xx (warn) / 5xx (error) logs status,
  API `code`, message (≤300 chars), duration — never the request body.
- Test: `backend/tests/failed-response-log.test.ts` (1). Log retention length not changed (disk policy = owner).

### TEMP-SYNC-02 — Already Fixed
- CI has a separate BLOCKING job `sync-multidevice` (`npm run test:sync-multidevice`) and the script re-clones
  HUB/A/B from the template per scenario group (FIN-08 comment). The older advisory step in the `build` job is a
  leftover duplicate with an outdated comment — left in place (harmless). The drill itself was not run here
  (3 API processes + PostgreSQL; RAM).

### TEMP-STAT-02 — PARTLY FIXED (22 of 47 reviewed and re-stamped) / BLOCKED (24)
- Method: for each drifted twin, found the commit where the PG source had the stamped sha256, normalized both
  versions with prettier and diffed. 22 PG sources (23 twin files) had a base: 17 format-only; 5 with real
  changes (UserRepository, SyncMaterializeStore, SettingsRepository SS-01, SyncDeviceRepository
  `retireFingerprint`, dayLockHelper H-08) — each present in its twin (dayLock advisory locks are PG-only;
  SQLite has one writer and its `lockDay` exists). Those 23 headers re-stamped.
- 24 remain: the stamped content never existed in any commit (stamped from a working copy), so no base can be
  recovered; closing them needs a full PG↔twin comparison per file. Safety net: both engines' full suites
  green. `--check` not made a CI gate while 24 remain (it would fail every build).

## 4. Final results (actual runs, 2026-10-12, sequential)

| Check | Result |
|---|---|
| Frontend + shared (`npx vitest run`) | **95/95 files, 417/417 tests** |
| Backend SQLite (`DB_ENGINE=sqlite npx vitest run`) | **180 passed, 10 skipped, 0 failed files · 971 passed, 43 skipped** |
| Backend PostgreSQL 17 (new disposable cluster `%LOCALAPPDATA%\Temp\r6bk\pg` on :56437, `erp_test`; stopped after) | **191/191 files, 1018/1018 tests** (includes the live invitation ERP-002 case) |
| `tsc` root / backend / admin-dashboard | 0 / 0 / 0 |
| `npm run typecheck:sqlite` (schema + fingerprint) | passed |
| Root lint / backend lint | 0 errors, 48 warnings (exit 0) / exit 0 |
| `npx prettier --check .` | all files pass |
| `npm run build` | exit 0 |
| Desktop script tests | 24 pass, 7 fail — all `EADDRINUSE 127.0.0.1:8080` (port held by an owner process; not stopped) — BLOCKED (environment), same as earlier rounds |
| Rust `cargo test` | not run this round (no Rust change) |

First SQLite run found one failure caused by this work (`sync-coverage.test.ts`: the replace endpoints were
not registered; a template-literal path also hid them from the scanner) — fixed by two literal routes +
two registry entries, then the full suite was re-run (result above).

## 5. Still open

- **Blocked (owner decision):** M-02 per-currency day close · H-04 header discount on returns · L-02 production
  collation · uninstall keeps data (#7) · build-tree clean-up (#8) · C1-06 debtors ordering · factory reset
  from the login screen · global route guard for warehouse/viewer.
- **Blocked (data/environment):** F-006 (database copy from 2026-08-18..23) · M-12 remaining advisories (major
  upgrades) · stale installer (#6 — needs a release build + owner install) · desktop script gate (port 8080) ·
  live Vite-proxy run for ERP-005 · two-device live run for NEW-01/ERP-008 replay.
- **TEMP-STAT-02:** 24 SQLite twins whose stamped base is not in git — need a full per-file PG↔twin review.
- **Risks:** NEW-01 parks an admin's user edit that happens to be pushed under an accountant session (visible,
  re-save fixes it). ERP-001 invalidation is per process (complete for one-process hub/desktop; a multi-replica
  hub would need shared invalidation). The hub must run this version for NEW-01 and the replace endpoint.
- Nothing committed, pushed or deployed; no production data touched; the four source files in `1/` unchanged.

---

# Round 7 — every lint warning, hidden warning and environment-dependent test (2026-10-12)

Constraints this round (owner): SQLite only (no PostgreSQL started or touched), no build/package/installer,
no commit/push, nothing deleted, no other process stopped, no warning hidden, no rule disabled.

## Starting point (verified)
Root ESLint: 0 errors / **48 warnings** + 4 `eslint-disable` comments that hid more (3 frontend
`react-hooks/exhaustive-deps`, 1 test `rules-of-hooks`) + 2 backend `no-explicit-any` disables (and the backend
config switched unused-directive reporting off). Desktop script tests: 7/31 failing.

## Real defects the warnings exposed — FIXED
| # | Defect | Fix | Test |
|---|---|---|---|
| R7-1 | Sale-invoice edit: when the warehouse list loaded after the invoice, the one-shot prefill skipped the stored warehouse → re-saving silently moved the invoice to the default warehouse | separate effect that waits for the list (`warehouseToRestore`) | `src/components/print/warehouseToRestore.test.ts` (3) |
| R7-2 | Print-receive: "manual FX needed" memo read rolls from the store without depending on it → could stay on a stale "SYP" guess and hide the FX field | reads `inventory.rolls` through the snapshot, `jobById` memoized | covered by R7-4 tests (snapshot) |
| R7-3 | FX reference badge: the visibility handler captured the mount-time `nowMs` → after the threshold every tab return refetched, even right after a load | last-load time in a ref | source-verified (no React renderer for timers) |
| R7-4 | 10 memos keyed on an unused store version number (invisible dependency, 1 hidden by a disable) | `useInventory()` / `useParties()` return a snapshot (live arrays, new identity per change); memos read through it | `useInventory.snapshot.test.ts`, `useParties.snapshot.test.ts` |
| R7-5 | Error toasts could show "undefined — …" or "[object Object]" (5 ad-hoc `as any` readers) | `src/lib/resultErrorMessage.ts` | `resultErrorMessage.test.ts` (3) |
| R7-6 | Activation: `new Error(data.message || …)` with an untyped body → "[object Object]" if a non-string message arrived | typed `SetupApiBody` + `resultErrorMessage` | tsc |

## Clean-ups behind the remaining warnings
- Dead code removed: `useTenantContext` (never called), the AppShell saved-open-group restore (always overridden in
  the same commit by the follow-the-page effect — no visible change) and its `hydrated` state, a stale disable in
  `PartyDetails`.
- `x ?? []` lists memoized (5) — stable inputs for the memos below them.
- Fast refresh: helpers/constants moved out of 10 component files into `.ts` modules (`activationTrust`,
  `resolveTenantId`, `cashProfit`, `cashBoxes`, `useClientPage`, `liveStockText`, `partyDeleteConfirm`,
  `partyFormModel`, `factoryResetConfirm`); importers and tests updated (type re-exports kept).
- 20 `any` replaced by real types (tests and code). `useOrders.test.tsx` now renders a real component with
  `react-dom/server` instead of calling the hook as a plain function. Backend: `health.route.ts` `rbac` typed,
  `idempotency-handler` assigns `res.json` without a cast; backend lint config no longer turns unused-directive
  reporting off.
- Gate tightened: `npm run lint` is now `--max-warnings 0`.
- `PartyTable.refresh.test.ts` updated to the snapshot contract (same intent, plus "no eslint-disable").

## Desktop script tests — FIXED (root cause: the test needed two free ports)
Verified cause: 127.0.0.1:8080 is held by another `node` process (PID 11332, not stopped). The test bound
decoys on 8080/4173 and aborted when one was already taken. Now: an already-held port counts as "busy" (the
precondition), and the test asserts directly that the ERP process has **no listening TCP socket at all**
(`netstat -ano` by the server's PID — probe verified it reports a real listener). 31/31 pass.

## TEMP-STAT-02 (24 twins) — still not provable by tooling
Their stamped base never existed in git; their last commit is the owner's bulk commit 7eaabec1, and the PG
sources have not changed since (prettier-normalized) — but a change made inside that same commit cannot be
told apart. Evidence of parity available: both repos implement the same ports (tsc), the SQLite suite passes.
A per-file manual PG↔twin review is still required to close it.

## Results (actual runs, SQLite only)
| Check | Result |
|---|---|
| Frontend + shared | **99/99 files, 425/425 tests** |
| Backend SQLite | **180 passed, 10 skipped (PostgreSQL-only files), 0 failed · 971 passed, 43 skipped** |
| Desktop script tests | **31/31** |
| `tsc` root / backend / admin · `typecheck:sqlite` | 0 / 0 / 0 · passed |
| ESLint root / backend | **0 errors, 0 warnings** (`--max-warnings 0`) / exit 0 |
| `prettier --check .` | all files pass |
| Not run (by instruction) | PostgreSQL suite, build, Rust compile/tests |
