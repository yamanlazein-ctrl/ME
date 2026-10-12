# MOTARD ERP — VERIFIED FIXES (2026-10-11)

Independent verification of `MOTARD_ERP_FULL_FORENSIC_AUDIT.md`. Nothing committed, pushed or deployed. No customer data, backups or secrets touched.

## Final verdict: **NOT READY**

**Why:**

- The installer durability drills haven't run (DT-04).
- The live Google Drive round-trip hasn't run.
- Auto-update needs the signing key (DT-01).
- The browser e2e suites haven't passed (see below).
- My own live-PostgreSQL full run was stopped by the host for low memory. The PostgreSQL result below (958/0) comes from the concurrent session's run, not mine.

> **Two agents worked on this tree at once.** The "SESSION 2 CHECKPOINT" section at the end was written by a separate concurrent session (it owns the backend on :8080, PID 11332). Its sections are left as written.

## Tooling

| Tool              | State                                 | Use                                                                              |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| Ponytail          | Full mode active                      | Smallest root-cause fixes                                                        |
| Mem0              | Authenticated; search works           | Store was empty (no flushes yet)                                                 |
| Superpowers 6.4.1 | Installed                             | systematic-debugging; failing test first, then fix                               |
| Context7          | Available                             | Not needed so far                                                                |
| Trail of Bits     | **Not installed** (marketplaces only) | `/plugin install <name>@trailofbits`                                             |
| Playwright MCP    | **Not installed**                     | The repo's own Playwright suites need PostgreSQL + a running stack (not yet run) |

## Baseline (before fixes)

- Backend, `DB_ENGINE=sqlite npx vitest run`: 882 passed / 37 skipped.
- Frontend, `npx vitest run`: 317/317.

## Final verification (lead session, 2026-10-11, summary lines read)

| Check                                     | Result                                                                                                                                                                                                                                                                                                            | Class                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Backend `DB_ENGINE=sqlite npx vitest run` | **914 passed / 40 skipped / 0 failed** (164 files; baseline 882)                                                                                                                                                                                                                                                  | local integration (real temp SQLite) |
| Frontend `npx vitest run`                 | **353/353** (80 files; baseline 317) — includes the 4 `packages/shared` money-math files                                                                                                                                                                                                                          | unit/component                       |
| `npx tsc --noEmit` root + backend         | 0 errors                                                                                                                                                                                                                                                                                                          | static                               |
| `npm run typecheck:sqlite`                | passes (51 files/53 tables; fingerprint 60 tables, 442 CHECK, 11 triggers)                                                                                                                                                                                                                                        | static + schema gate                 |
| `npm run build`                           | ✓ built (with the `seroval` 1.6.9 override)                                                                                                                                                                                                                                                                       | build                                |
| `npm audit --omit=dev` root / backend     | **0 / 0** vulnerabilities                                                                                                                                                                                                                                                                                         | supply chain                         |
| `npm run lint`                            | 618 Prettier-only errors: 394 = CRLF in the untracked Drive files (`settings.drive.tsx`, `drive-archive.ts`; normalized by `.gitattributes` on commit), the rest pre-existing at HEAD (verified per file). The 2 introduced this session were formatted.                                                          | static                               |
| `cargo test` (desktop/src-tauri)          | **104 lib + 7 bin passed, 0 failed**                                                                                                                                                                                                                                                                              | Rust unit                            |
| `node --test desktop/scripts/*.test.mjs`  | **24 passed / 7 failed** — the 7 are all `server-bundle.test.mjs`, failing with `cannot bind decoy on 127.0.0.1:8080 (EADDRINUSE)`: port 8080 is held by the concurrent session's backend. **Environmental, not a code defect**; the Drive fork's earlier run with 8080 free was 31/31. Re-run once 8080 is free. | packaging integration                |
| Backend on live PostgreSQL (full)         | my run (`…56437/erp_test`) was **killed by the host for low memory** before finishing — no result. The concurrent session reports 958/0 on its own cluster (56438), not re-verified by me.                                                                                                                        | —                                    |
| Browser e2e (`playwright.cert.config.ts`) | **NOT RUN.** `tests/e2e/cert-stack.mjs` now accepts `CERT_BACKEND_PORT`/`CERT_UI_PORT` so it can run beside a server on 8080; point the suites at it with `PLAYWRIGHT_BACKEND_URL`/`PLAYWRIGHT_BASE_URL`.                                                                                                         | —                                    |

**Resolved since the first write-up:** NEW-02 (`seroval` critical — override to 1.6.9; production audit now clean); the settings-section trust gap (SS-01 allowlist present in both repositories, test 4/4; the company replay maps fields explicitly and forces `tenantId`, so it is not exposed); the IPC ACL test is in CI (both jobs).

## Still to do

1. Free port 8080 (the other session's backend), then: `node --test desktop/scripts/server-bundle.test.mjs`.
2. With enough free memory: start the bundled PostgreSQL on a port outside the Windows excluded range 55372–55471 (e.g. 56437), run the full backend suite on it, then the cert e2e:
   `E2E_ADMIN_PASSWORD=<pick one> CERT_PG_PORT=56437 CERT_BACKEND_PORT=18080 CERT_UI_PORT=18081 node tests/e2e/cert-stack.mjs`, then
   `PLAYWRIGHT_BASE_URL=http://localhost:18081 PLAYWRIGHT_BACKEND_URL=http://localhost:18080 npx playwright test --config=tests/e2e/playwright.cert.config.ts`.
3. Review the concurrent session's `enable-rls.sql` change (`revoked_tokens` exemption, RV-03a) — I haven't independently verified it.
4. Owner/external: DT-01 signing key; DT-04 installer drills; Drive OAuth client id + test account + consent-screen publishing; S-05 per-section settings timestamps; S-04 claim-expiry design for `received` units; FIN-01 decimal arithmetic.

## Security, financial and desktop findings (lead)

### SEC-01 [P1 in audit → P2 verified] Pre-auth wizard restore reachable from the LAN — CONFIRMED (narrower than claimed), FIXED

- **Evidence:** `backend/src/infrastructure/http/localAccess.ts` `resolveDesktopLocalCaller` returned `isLocalOrPrivateLan(address)` on TCP, so any RFC1918/link-local/ULA peer counted as "this machine". Callers: `setup.route.ts:70` `requireLocalAccess` (all wizard POSTs incl. `/api/setup/wizard/restore-path` at :375), `auth.route.ts:188` (DEVICE_PROOF bypass for a "local operator"), `auth.route.ts:50` (login rate-limit skip). Second vector: `server.ts:94` `trust proxy 1` on the desktop too, so `req.ip` came from a client-supplied `X-Forwarded-For` — any caller could claim `127.0.0.1`.
- **Correction to the audit:** the shipped desktop binds a named pipe (`stack.rs:467` sets `DESKTOP_PIPE`; `server.ts:710`) and has no TCP port, and a TCP desktop run defaults `HOST=127.0.0.1` (`env.ts:49`). The LAN exposure is real only for a TCP-bound `DESKTOP_DEPLOY` run with `HOST` overridden (QA/dev harnesses). Not reachable on a stock install → severity P2, not P1.
- **Root-cause chain:** LAN device restores an arbitrary file / skips device proof → `requireLocalAccess`/device-proof accept the peer → `resolveDesktopLocalCaller` widens "local" to the whole private LAN, and `req.ip` trusts `X-Forwarded-For` → the trust boundary was defined as "the customer's network" instead of "this machine", and the hub's proxy setting was applied to the desktop process, which has no proxy.
- **Fix:** on TCP, only loopback is the local desktop caller (`resolveDesktopLocalCaller` → `isLoopbackAddress`); the now-unused `isLocalOrPrivateLan` deleted. `server.ts`: `trust proxy` = `false` when `DESKTOP_DEPLOY`, `1` on the hub. One change at the shared function fixes all three callers.
- **Not done (deliberately):** mandatory sha256 on `restore-path` — it's an integrity check, not an access control (an attacker naming a file can hash it); the shell already always sends it (`main.rs` `pick_backup_file`). The audit's "allowlist-prefix the path" is not applicable: the operator may pick a backup from any folder via the native dialog.
- **Tests:** `backend/tests/local-access.test.ts` new case "a LAN peer is NOT the local desktop caller on TCP" — RED first (`expected true to be false`), GREEN after. `npx vitest run tests/local-access.test.ts tests/dfp030-loopback-bind.test.ts` → 6/6 passed.
- **Remaining risk:** none on the pipe build. Restore by path remains possible for any process running as the desktop user (same trust as the user).

### NEW-01 [P2] `DESKTOP_DEPLOY` parsed with `z.coerce.boolean()` — CONFIRMED, FIXED

- **Evidence:** `env.ts:24` `z.coerce.boolean()` turns the string `"false"` into `true` (the file already documents this trap for `NUMBER_BLOCKS_ENABLED` at :30 and fixed it there only). `DESKTOP_DEPLOY` relaxes three production boot gates (setup token, Redis, license signing key) and, before this fix, the local-access boundary.
- **Root-cause chain:** a hub configured with `DESKTOP_DEPLOY=false` would boot in desktop mode with production gates relaxed → coerce semantics → the sibling fix was applied to one flag, not to the pattern.
- **Fix:** same explicit enum parser as `NUMBER_BLOCKS_ENABLED`. `envSchema` exported for the test. All writers set `"true"` (stack.rs, parity scripts, tests) — verified by grep.
- **Tests:** `backend/tests/env.test.ts` "DESKTOP_DEPLOY parsing (NEW-01)" → 4/4 passed.

### SEC-02 [P2] No pino redaction — PARTIALLY CONFIRMED, FIXED (defense in depth)

- **Evidence:** `logger.ts` pino options had no `redact`. **Correction:** the audit's "request bodies logged (`server.ts:197-200`)" is false — that middleware logs only `requestId/method/path`; a grep for log calls carrying `body/headers/token/password/authorization` found none. No live leak path was found; the risk is one future `logger.error({ err })` on an HTTP-client error whose config holds an `Authorization` header.
- **Fix:** `LOG_REDACT_PATHS` (password/token/accessToken/refreshToken/apiKey/secret/authorization/cookie at depth 1–2, `*.headers.authorization`, `err.config.headers.Authorization`) with `censor: "***"`.
- **Tests:** `backend/tests/logger-redaction.test.ts` → 1/1 passed (four secrets masked, non-secret fields kept).

### SEC-04 [P3] license-server openLoopback / trust proxy — DISPROVEN as a vulnerability

- `license-server.ts:174-177` reads raw `process.env.NODE_ENV`, but `config.NODE_ENV` also defaults to `"development"` (`env.ts:18`), so switching would change nothing. Open loopback forces a `127.0.0.1` bind (`licenseListenHost.ts:22`, DFP-030 tests pass) and the license server sets no `trust proxy`, so `req.ip` is the real socket peer. Open-loopback-without-login is a documented owner design ("Local owner console"). The main server's `trust proxy` half is fixed under SEC-01.

### SEC-03 [P2] Live RLS — BLOCKED (see Sync section for whether a local PostgreSQL could be started)

### FIN-01 [P3] Float money arithmetic — CONFIRMED RISK, owner decision

- `packages/shared/src/precision.ts` `round2dp` = `Math.round(n*100)/100`, with an explicit comment that the replacement needs a business decision. Storage is scaled-integer; totals are server-side. Not changed.

### FIN-02 [P2] Day-lock only on cash invoices — DISPROVEN

- The day lock is documented as a cashbox lock (`sqlite/helpers/dayLockHelper.ts:9-16`: "Reject cashbox writes on a day that has been closed … manual cashbox movements, vouchers and cash expenses"). A credit sale writes no cash leg. The year lock runs on every invoice on both engines (`SqliteInvoiceRepository.ts:186`, `PostgresInvoiceRepository.ts:181`). Consistent by design.

### DT-01 [P1] Auto-update impossible — CONFIRMED, BLOCKED (owner decision)

- `tauri.conf.json:60` `createUpdaterArtifacts: false`; pubkey + endpoint present. Needs the minisign private key and a publish target.

### DT-07 [P3] No graceful shutdown on normal exit — CONFIRMED, FIXED

- **Evidence:** `supervisor.rs` monitor exit → `stack::shutdown` → `kill_and_wait` = `TerminateProcess` (`hidden_process.rs:216`). The graceful `/api/desktop/runtime/shutdown` (write gate held → `wal_checkpoint(TRUNCATE)` → exit, `desktopRuntime.route.ts:43`) was used only by the update path (`main.rs:1015`).
- **Root-cause chain:** every normal exit/session end hard-kills the sidecar → the teardown path never called the graceful endpoint → graceful stop was built for the updater only.
- **Fix:** `supervisor.rs` `graceful_stop(&store)` before `stack::shutdown`: POSTs the runtime shutdown with the existing runtime token (sha256 of APP_MASTER_KEY, same as `main.rs:runtime_token`), bounded to 4 s on a helper thread because the pipe read has no timeout; the hard stop remains the fallback.
- **Tests:** `cargo test --lib supervisor` → 14 passed incl. new `graceful_stop_is_bounded_when_no_server_answers`. `cargo check --lib` clean. **Not proven:** the clean-close effect on a real install (part of DT-04).

### DT-02 residual [P3] Factory-reset WebView clearing lives in the two frontend callers — CONFIRMED RISK, not changed

- Both existing callers clear tokens/license/email/sync state (`UserPickerPage.tsx`, `FactoryResetCard.tsx`). Moving it into Rust is only protection for a hypothetical future caller.

### DT-04 [P1] Installer durability scenarios — BLOCKED

- Needs a built + installed release and force-kill/session-end drills on Windows.

## Google Drive integration and desktop IPC

All work below is local integration testing on real temporary SQLite with a fake Drive. **No live Google call was made.** Every CONFIRMED item had a test that failed first and passes after the fix.

**Fork verification run (2026-10-11, summary lines read):** 14 Drive/backup/restore/sync-coverage test files → 194 passed, 0 failed; `npx tsc --noEmit` backend + root → 0 errors; `node --test desktop/scripts/*.test.mjs` → 31 pass; `cargo check --profile dev-fast` clean; `cargo test --lib --profile dev-fast` → 104 passed; `generate-sqlite-schema.mts --check` + `sqlite-schema-fingerprint.mts --check` pass; schema-type-parity + migrations-journal-guard + schema-migration-parity → 17 passed.

### D-01 [P1] Token never reached the sidecar — CONFIRMED, FIXED

- **Evidence:** `server.ts` wired `driveClient: null`; queue and folders got `null as never`; `google_access_token` (Rust) had no caller; the doc comment named a command that didn't exist.
- **Root-cause chain:** `/drive/test` → 409 `NOT_CONNECTED` forever → no token in the Node process → the Rust↔Node token bridge was never built; the completion ledger counted IPC registration as "done".
- **Fix:** Rust pushes the access token over a new runtime-token-gated `POST /api/desktop/runtime/drive-token` (`google_ipc::push_token_to_sidecar`) on connect, `null` on disconnect, and from a refresh thread every 30–300 s. The backend holds it in memory only (`setLiveDriveToken` in `driveClient.ts`); one real `DriveClient` is returned only while a valid token is held; the first token triggers an archive pass. `google_access_token_cmd` removed, so the webview never sees a token. `runtime_token()` moved into `secret_store.rs` so `main.rs` and `google_ipc.rs` share it.
- **Audit correction:** the `hidden_process.rs` allowlist filters only the inherited parent environment; explicit `.env()` values pass.
- **Test:** `desktop-runtime-route.test.ts` — 404 without the token, 400 on a bad body, set, clear.

### New defects found on the same chain — CONFIRMED, FIXED

- **D-11:** Rust sent `consent_url`, the UI read `consentUrl` → `window.open(undefined)`. Fixed with serde camelCase.
- **D-12:** the main window's navigation guard blocks Google's consent page. Rust now opens the system browser (`ShellExecuteW`); the UI's `window.open` removed.
- **D-13:** Google commands were synchronous → ran on the main thread → froze the window for up to 5 minutes during consent. Now async with `spawn_blocking`.
- **D-14:** the Drive wiring wrote through the raw `writerDb`, bypassing the write gate, so its writes could land inside a business transaction and roll back with it. Now uses `sqliteDb()`.

### D-02 [P1] Every Drive route returned 401 — CONFIRMED, FIXED

- Hand-rolled guard read a nonexistent `req.ctx`. Now `rbac(["admin"])`; status reports `localDeviceId`.
- **Test:** new `drive-route.test.ts` — admin 200, viewer 403, no session 401, every route admin-only. Before the fix an admin got 401.

### D-03 [P1] Uploads would be empty — CONFIRMED (reproduced as 0 bytes), FIXED

- `process(job, date, content)` now takes the bytes directly; the mutable `contentSource` hook is gone (a concurrent pass could swap it). `regenerate()` rebuilds bytes from the source and checks the queued sha256 (mismatch → stale row dropped). Files over 5 MB use the resumable upload.

### D-04 [P1] Token leaked into logs — CONFIRMED, FIXED

- The regex had changed since the audit, but `[\w-]+` still stopped at the first `.` in `ya29.…`. New regex `/(Authorization:\s*)(?:Bearer\s+)?\S+/gi` plus a `ya29.` sweep. The old test only checked for "ya29", so it never caught the leak.

### D-05 [P1] No device identity — CONFIRMED, FIXED

- Backend-only: `localDeviceId = config.MOTARD_INSTALLATION_ID`, the stable id the desktop already passes at spawn. No Rust/env change needed.

### D-06 [P1] Backup hook never called — CONFIRMED, FIXED

- The newest VERIFIED backup is enqueued every pass. Test: it uploads byte-identical and ends `done`.

### D-07 [P2] No way to enable archiving — CONFIRMED, FIXED

- Drive settings has an enable/stop control calling the existing `PUT /api/settings/drive` (synced to the hub). Typecheck-verified only; no UI test.

### D-08 [P2] Lease CAS inert — CONFIRMED (two winners reproduced), FIXED

- The claim UPDATE re-checks that the row is still due, so a second claimer updates nothing.

### D-09 [P3] Identical failure statuses — CONFIRMED, FIXED

- Permanent/exhausted → `blocked`; retryable stays `failed` with a next attempt. UI labels and the retry button cover `blocked`.

### D-10 [P2] Jobs reclaimed forever — CONFIRMED, broader than the audit, FIXED

- Renamed/cancelled invoices looped too, not only backups; a job whose source is gone or changed is now dropped. The primary-device gate now runs before any export (every secondary device previously exported 24 months every 6 hours). Timer and manual pass share one in-flight guard. Purchase invoices and expenses now archived (exporters existed but weren't wired).

### DT-06 [P1] 7 Tauri commands ACL-dead (desktop restore-from-file broken) — CONFIRMED, FIXED

- At HEAD `pick_backup_file` was registered but absent from `build.rs` (checked with `git show`). Added it and the five remaining `google_*_cmd` to `build.rs` `APP_COMMANDS` and `capabilities/main-window.json`.
- **Guard:** new `desktop/scripts/ipc-acl-wiring.test.mjs` (4 checks) — fails against HEAD.

### DB-07 [P2] `settings.drive` accepts non-JSON — CONFIRMED, FIXED in place

- Safe to edit 0005 in place: never committed, and the bundled migrations stop at 0004. Added the `json_valid` CHECK; test: a non-JSON value now throws. Limitation: the fingerprint reader sees only table-level constraints, so this column CHECK is enforced but not fingerprinted.

### DB-08 [P2] Per-device Drive ledger included in backups — CONFIRMED, FIXED

- **Audit correction:** adding to `INTERNAL_TABLES` would only stop hashing; rows would stay in the archive. The right list is `EXCLUDED_TABLES` (empties them in the archive, keeps the live device's ledger on restore). `sync_outbox` stays in backups on purpose (pending work must survive a restore); the migration comment saying otherwise was wrong and is corrected.
- **Test:** new `sqlite/backup-drive-ledger.test.ts` — found 1/1/1 rows in the archive before the fix.

### DB-10 [P3] Drive migration lacks `IF NOT EXISTS` — DISPROVEN, no change

- SQLite migrations are forward-only, journal-gated, transactional and fingerprint-checked; `IF NOT EXISTS` would only hide drift.

**Files changed:** backend `googledrive/uploadQueue.ts`, `monthlyArchiveJob.ts`, `driveClient.ts`, `routes/drive.route.ts`, `routes/desktopRuntime.route.ts`, `server.ts` (Drive block), `syncCoverage.ts`, `backup/sqliteBackup.ts`, `sqlite/migrations/0005_drive_archive.sql`; tests new `drive-archive-pipeline.test.ts` (7), `drive-route.test.ts` (2), `sqlite/backup-drive-ledger.test.ts` (1), edited `sqlite/desktop-runtime-route.test.ts`, `drive-client.test.ts`, `drive-upload-queue.test.ts`; frontend `settings.drive.tsx`, `lib/drive-archive.ts`, `SettingsApiService.ts`; desktop `google_ipc.rs`, `main.rs`, `google_oauth.rs` (doc), `secret_store.rs`, `build.rs`, `capabilities/main-window.json`, new `desktop/scripts/ipc-acl-wiring.test.mjs`.

**Blockers / remaining risks**

1. **External:** no real OAuth consent, Drive round-trip or browser launch was run — needs the owner's OAuth client id, a test Google account and a click-through on a built installer. The consent screen must be published, or refresh tokens expire after 7 days.
2. **Pre-existing:** a crash after Google accepts a file but before it is marked done re-uploads a duplicate (no reconcile by Drive file id).
3. **Dev-only:** an archive made by the pre-fix dev Drive build would hit a UNIQUE conflict on restore; the restore is refused and data unchanged. No shipped build produced such archives.

## Sync engine

**Live-PostgreSQL setup used for the sync proofs:** throwaway PostgreSQL 17.10 from `desktop/retired-postgres/resources-postgres/bin`, data dir in the session scratchpad, port **56437** (55432/55433/55437 fall in a Windows excluded TCP range 55372–55471 → "Permission denied"; check with `netsh interface ipv4 show excludedportrange protocol=tcp`). `node scripts/ensure-test-db.mjs` → "migrations applied — 53 tables". Connected as superuser `postgres` (bypasses RLS) — **not an RLS proof**.

### S-01 [P1] Roll-adjustment replay not idempotent — CONFIRMED, FIXED

- **Evidence:** `tryMaterializeAcceptedUnit` (`syncUseCases.ts`) commits `materializeSyncUnit` and only then calls `inbox.markApplied` separately (the device pull path `markLocalApplied` is the same); `materializeRollAdjust` re-applied the delta on every delivery; `applyRollAdjustment` (both engines' `inventoryCountRepository.ts`) had no once-only check.
- **Root-cause chain:** double stock delta + double inventory-P&L leg after a crash/5xx → a re-delivered roll-adjust unit is applied again → the only idempotency is the inbox row reaching `applied`, which commits after the effect, not with it → the function's comment claims "the inbox op id makes it once-only" but nothing stored the op id with the effect.
- **Siblings checked:** every other materialize branch is idempotent through an id-keyed existence check (documents, ledger legs, frozen settlement legs, cashbox movement id, print job id, cancel via `ALREADY_CANCELLED`). Roll-adjust is the only pure delta.
- **Why not `referenceId` (audit's suggestion):** tried first; it broke "a posted roll can be counted again" — one count line legitimately posts a new correction per re-count with the same `referenceId`, and pieces-only adjustments write no stock movement.
- **Fix:** the sync op id is the unit's identity: `materializeRollAdjust` passes `syncOpId: meta.opId`; `applyRollAdjustment` stores it in the adjustment's audit `afterSnapshot` (exactly one audit row per adjustment, same transaction) and, when given a `syncOpId` already present on that roll's `inventory_adjustments` audit rows, returns `{ alreadyApplied: true }` without touching the roll (indexed lookup `idx_audit_logs_tenant_entity`; audit rows are never pruned). Materialize maps `alreadyApplied` → `exists`. Local adjustments unaffected.
- **Tests:** `tests/sqlite/roll-adjustment.test.ts` +2 — same unit delivered twice → `created` then `exists`, roll 96 kg / 11 pcs, version 2, exactly 1 movement + 1 ledger leg; pieces-only twice → `alreadyApplied`, change lands once. RED: `expected 'created' to be 'exists'`; GREEN 14/14.
- **Remaining risk:** a unit received before this build and re-delivered after the upgrade has no `syncOpId` in its earlier audit row (narrow upgrade window). The PG copy got the identical change but its behavioural test runs on SQLite only. Legacy settlement fallback (no frozen legs) converges by recomputing under a party row lock — noted residual.

### S-02 [P1] Delete+tombstone atomicity fails on PostgreSQL — CONFIRMED (deeper than reported), FIXED, PROVEN ON LIVE PG

- **Evidence:** F-03 wrapped the master delete in the engine's `runInTransaction`; on PG that is a bare `db.transaction(fn)` (`orm/engine.ts:57-61`) that never publishes the ambient transaction (only `withTenantTx` calls `runInAmbientTx`). The master repos are built on `ambientDb(db)` (`postgresContainer.ts:125`), so without an ambient tx they ran on their own connection, and `PostgresSyncMaterializeStore.recordTombstone` wrote through the raw pool → on PG the wrapper grouped **nothing**. SQLite twin: `recordTombstone` went through `runAutonomous`, which re-runs the write after a rollback, so a tombstone could persist for a delete that rolled back.
- **Root-cause chain:** deleted row with no tombstone (stale create resurrects it) → delete and tombstone commit on different connections → `runInTransaction` isn't an ambient tx on PG, and the tombstone store was designed "autonomous" (research I-2) → F-03 was verified on SQLite only (its test forces `DB_ENGINE=sqlite`).
- **Fix:** `syncMaterialize.ts` uses `withTenantTx(ctx.tenantId, …)` (publishes the ambient tx and `SET LOCAL app.current_tenant_id`); `PostgresSyncMaterializeStore` takes `txDb` and writes the tombstone through it; `SqliteSyncMaterializeStore.recordTombstone` writes through the ambient db (constructor `(independent, ambient)`; `engineStores.ts` wires both); PORTED-FROM hash re-stamped.
- **Tests:** new `tests/master-delete-tombstone-atomicity-pg.test.ts` (live PG only, skipped on SQLite): delete at base version commits with its tombstone; with a CHECK refusing the tombstone, the delete rolls back. RED on live PG with the original code: `delete must roll back with the failed tombstone: expected false to be true`; GREEN 2/2. `tests/sqlite/autonomous-writes.test.ts` test 3 asserted the old behaviour ("tombstone survives its rollback") and was rewritten to the new invariant — an intentional behaviour change, not a weakened assertion. SQLite F-03 test still 1/1.
- **Remaining risk:** proven as superuser only; under `app_user` the tombstone INSERT runs on the `SET LOCAL`-scoped connection, which should satisfy `tenant_isolation`, but that wasn't exercised live.

### S-03 [P2] Roll update/delete replay lacks write-time CAS — CONFIRMED, FIXED

- **Evidence:** roll update replay called `updateRollUseCase(…, updateInput)` without `expectedVersion` although the repo supports a versioned WHERE (H-5); fabric/colour/roll deletes take no version; only the read-time `hub.version !== baseVersion` check guarded them. Hub units from two devices arrive as separate requests, so the read→write gap is real. Sibling noted, unchanged: local `PUT /inventory/rolls/:id` is also blind (`updateRollSchema` strips `expectedVersion`).
- **Fix:** roll update passes `expectedVersion` (same rule as siblings); a CAS miss returns retryable `failed`, and the retry's read records the conflict. Deletes: `masterStillAtVersion` inside the `withTenantTx` runs `UPDATE … SET version = version WHERE version = base` (also holds the PG row lock until commit): present at another version → `conflict` + conflict record; row already gone → proceed (tombstone still recorded).
- **Tests:** new `tests/sqlite/master-replay-cas.test.ts` (repo returns v1 while the row is at v2): delete → `conflict`, row kept, no tombstone; roll update → not `created`. RED `expected 'created' to be 'conflict'` → GREEN 2/2.

### S-04 [P2] Claims held by never-converging units — CONFIRMED (sharper), PARTIALLY FIXED

- **Evidence:** claims are released only after a successful apply or a conflict. A unit parked `dead` (invalid, or past `MATERIALIZE_MAX_ATTEMPTS` = 5) kept its claims until an operator called `POST …/claims/reap` (no scheduler), although that function's own safety argument says dead claims can never serve a future apply.
- **Fix:** `releaseDeadUnitClaims` at both re-read sites in `receiveSyncPush`, via `releaseByOp` only (a dead cancel can't free the create's claims).
- **Not done (unsafe):** time-based expiry of claims held by `received` units — a returning device's re-push takes the retry path, which doesn't re-claim, so the unit would apply without first-write-wins protection (oversell). Proposal: hub-side scheduled retry of `received` rows, or re-claim on the retry path before allowing expiry.
- **Tests:** new `tests/sync-dead-unit-claims.test.ts`: invalid → dead → released; retries exhausted → dead → released; still `received` → kept. RED (twice) → GREEN 3/3.

### S-05 [P3 → P2] Settings/company replay last-write-wins — CONFIRMED RISK, worse than reported, NOT FIXED

- `materializeAdminSnapshot` compares the whole settings row's `updated_at` with the incoming section's `updatedAt`, so an older-stamped edit of section A is dropped as `exists` whenever any section B was edited later — a cross-section lost update, on top of the equal-timestamp/skew window. Proper fix = per-section timestamps (schema change on both engines); deferred.

### S-06 [P3 → P2] Enrollment races — CONFIRMED (license-limit bypass), FIXED

- **Evidence:** `redeemEnrollmentCode` counts devices then inserts, and updates `uses` read-modify-write; N parallel redeems all pass. RED: 3 simultaneous redeems of a one-use code on a 2-device license → `expected [...] to have a length of 1 but got 3`.
- **Fix:** per-tenant in-process serialization (promise chain, map entry removed when idle), with a `ponytail:` comment naming the ceiling (single hub instance; several instances would need a DB advisory lock).
- **Test:** `tests/sqlite/sync-enrollment.test.ts` +1 — exactly one redeem succeeds, others `ENROLL_CODE_USED_UP`, one live device, `uses` = 1. GREEN 5/5.

### S-07 [P3] / N-07 casts — CONFIRMED, NOT CHANGED

- 14 lines in `syncMaterialize.ts`, 9 in `syncEnrollment.ts` = 23 (matches the audit). No new casts added.

### S-08 [P4] Ordering — VERIFIED

- Push lanes re-read (`ORDERED_LANE_TYPES`, lane 0 ordered). No change.

**Fork commands:** `DB_ENGINE=sqlite npx vitest run tests/sync tests/master-delete tests/roll tests/inventory tests/dye tests/sqlite` → 47 files passed / 5 skipped, 344 tests passed / 28 skipped. Live PG (`…56437/erp_test`): `tests/sync tests/master-delete tests/roll tests/inventory tests/dye` → 24/24 files, 198/198 tests. Backend `tsc --noEmit` clean.

**Files changed:** `syncMaterialize.ts`; `inventoryCountRepository.ts` (PG + SQLite helper); `PostgresSyncMaterializeStore.ts`; `sqlite/SqliteSyncMaterializeStore.ts`; `engineStores.ts`; `syncUseCases.ts`; `syncEnrollment.ts`; tests `sqlite/roll-adjustment.test.ts` (+2), `sqlite/master-replay-cas.test.ts` (new), `master-delete-tombstone-atomicity-pg.test.ts` (new), `sync-dead-unit-claims.test.ts` (new), `sqlite/sync-enrollment.test.ts` (+1), `sqlite/autonomous-writes.test.ts` (test 3 rewritten).

## Frontend

### FE-01 [P1] Success messages shown as error toasts — CONFIRMED, FIXED

- **Evidence:** five calls show a "تم…" (done) message with `toast.error`: `useCashbox.ts:92`, `useOrders.ts:110`, `useInventory.ts:638/666/700` (bulk dye/colour/fabric delete; plain async functions, so a scan of `onSuccess` handlers alone misses them).
- **Root-cause chain:** red "failed" toast on success → `toast.error` called with a success string → the error branch was copied into success paths; nothing ties toast kind to message meaning, and F-06 fixed only the three files it named.
- **Siblings:** an AST scan of `toast.error` inside `onSuccess` found 7 calls (4 are correct `else` branches); a regex over all of `src/` found exactly these 5.
- **Fix:** the 5 calls now use `toast.success`.
- **Test:** `src/presentation/hooks/__tests__/toast-semantics.test.ts` fails if non-test source calls `toast.error` with a `تم…` literal. RED listed the 5 offenders → GREEN.
- **Remaining risk:** it's a text check; a success message not starting with `تم` would slip through.

### FE-02 [P1] Party list stale after financial mutations — CONFIRMED (different root cause from the audit), FIXED

- **Audit wrong about the key:** `["party"]` is live (`usePartyBalance`, `useParties.ts:255`); the `["parties"]` hooks have no consumers.
- **Real source:** the customer/supplier list (`PartyTable.tsx:58-64`) shows `p.stats` from a module-level cache `_allParties`, refreshed only by `refreshParties()` — no React Query invalidation reaches it. Only `useCancelInvoice` and `PartyDeleteDialog` called it; invoice create, returns, expenses, orders, vouchers, settlement and cashbox did not.
- **Root-cause chain:** stale totals → list reads a module cache → the shared helper only knows React Query → earlier fixes patched single call sites instead of the helper.
- **Fix:** `invalidateFinancialViews` also invalidates `["parties"]` and calls `refreshParties()`, so every caller gets it; the two now-redundant calls (`useInvoices.ts`, `PartyDeleteDialog.tsx`) removed.
- **Tests:** `financial-invalidation.test.tsx` requires `"parties"` plus a new cache-refresh case (RED 2 failed → GREEN); `invalidateFinancialViews.test.ts` updated. 14 passed.
- **Remaining risk:** one extra party GET per financial mutation (concurrent loads share one in-flight request).

### FE-05 [P2] Money mutations bypass the central helper — CONFIRMED, FIXED

- `useVouchers.ts` (create receipt/payment, cancel) used a hand-written list missing party balance + module cache; `useCashbox.ts` manual movements (add, delete) refreshed only cashbox/dashboard although `SqliteCashboxRepository.ts:141/181` writes and cancels a ledger entry; `useStatement.ts` `invalidateAfterSettlement` missed profit, party balance and the module cache.
- **Not defects:** `useSetOpeningBalance` and `useCloseDay` write no ledger row.
- **Fix:** all 7 mutations call `invalidateFinancialViews(qc)` plus their own keys. Table-driven tests: RED 7 failed (each names its missing key) → GREEN.

### FE-03 [P2] Expenses screen stops at 20 rows and shows the truncated count — CONFIRMED, FIXED

- **Evidence:** `expenses.index.tsx:24` used `list.execute` (page array only) and showed `${list.length} مصروف`; the backend already returned `total`/`hasNext` and the hook discarded them.
- **Fix:** `useExpensesList` returns `{data, total, hasNext}` (same shape as `useVouchersList`); the screen uses the orders paging footer, resets to page 0 on filter change, and shows the server total.
- **Tests:** `src/presentation/hooks/__tests__/useExpensesList.test.ts` (RED → GREEN, 2 passed); `backend/tests/sqlite/expense-list.test.ts` on real SQLite: 25 rows → page of 20, total 25, next page holds 5 (3 passed).

### FE-06 [P2, NEW] Expenses date filter silently ignored — CONFIRMED, FIXED

- **Evidence:** the frontend sent `from`/`to`; the API schema (`packages/shared/src/schemas/expense.schema.ts:25-32`) accepts only `fromDate`/`toDate`; Zod dropped the unknown keys, so the من/إلى تاريخ (from/to date) inputs never filtered.
- **Fix:** keys renamed in `ExpenseDTO.ts` (+ `search`); empty inputs stay safe because `BaseHttpClient.ts:35` drops `""`.
- **Test:** `useExpensesList.test.ts` runs the hook's exact params through `listExpensesSchema.strict()`, so any key the API would drop fails.

### FE-04 [P2] Global search can't find expenses — CONFIRMED (partly), FIXED

- `GlobalSearch.tsx:31` called `useExpensesList()` with no filter (searched only the newest 20, client-side). **Correction:** the backend already searched number + description on both engines, but not category.
- **Fix:** GlobalSearch passes `{search, limit: 20}` like invoices/vouchers/returns; backend search also matches category (`SqliteExpenseRepository.ts`, `PostgresExpenseRepository.ts`).
- **Test:** category search in `expense-list.test.ts` RED (`expected [] to deeply equal ['EXP-07']`) → GREEN on SQLite. PostgreSQL path not run here (see Phase 4).

### FE-09 [P3 → P2] Double-submit on financial forms — CONFIRMED; the audit's mitigation claim DISPROVEN; FIXED

- `BaseHttpClient.ts:65-67` makes a new random idempotency key per `request()` call, so it covers retries inside one call, not a double click (two calls, two keys → two documents). The code comment claimed otherwise.
- Unguarded: `invoices.print-send.new.tsx`, `invoices.print-receive.new.tsx` (save one document per line in a loop, so `isPending` flickers between lines), `ReturnForm.tsx`, `orders.new.tsx`.
- **Fix:** a `saving` flag spanning the whole save (early return, reset in `finally`) on print-send/receive; `isPending` disables ReturnForm and orders; comment corrected.
- **Tests:** none behavioural (would need a full form-render harness) — covered by tsc, lint and the full suite only. **Gap.**
- **Remaining risk (out of scope):** if line N of a print-send/receive save fails after lines 1…N-1 committed, a retry posts the committed lines again.

**Files changed:** `useCashbox.ts`, `useOrders.ts`, `useInventory.ts`, `invalidateFinancialViews.ts`, `useInvoices.ts`, `PartyDeleteDialog.tsx`, `useVouchers.ts`, `useStatement.ts`, `ExpenseDTO.ts`, `useExpenses.ts`, `routes/expenses.index.tsx`, `GlobalSearch.tsx`, `invoices.print-send.new.tsx`, `invoices.print-receive.new.tsx`, `ReturnForm.tsx`, `orders.new.tsx`, `BaseHttpClient.ts` (comment), backend `SqliteExpenseRepository.ts` + `PostgresExpenseRepository.ts`; tests `toast-semantics.test.ts` (new), `useExpensesList.test.ts` (new), `financial-invalidation.test.tsx`, `invalidateFinancialViews.test.ts`, `backend/tests/sqlite/expense-list.test.ts` (new).

- **Fork-reported results:** full frontend suite 353/353 (80 files); root and backend `tsc --noEmit` 0 errors.

## Tests, CI and DB guards

### T-01 [P1] `packages/shared` money-math tests orphaned — CONFIRMED, FIXED

- **Evidence:** root `vitest.config.ts` include was `src/**/*.test.ts(x)`; `npx vitest run packages/shared/src` → "No test files found, exiting with code 1"; the backend config doesn't collect them either.
- **Root-cause chain:** money-math tests never ran → no config includes the sibling package → package has no runner of its own and was never wired in.
- **Fix:** `"packages/shared/src/**/*.test.ts"` added to the root include, so `npm run test:logic` (the CI unit step) collects them.
- **Result:** 4 files / 25 tests passed (fx, settlementAmounts, settlementAllocation, documentFilename). No money-math defect.

### DB-06 [P2] SQLite journal↔disk parity unguarded — CONFIRMED, FIXED

- **Evidence:** the guard read only `orm/migrations`; `sqlite/runtime.ts:153,228` applies migrations by `journal.entries`/`idx`, so an unlisted `.sql` is skipped silently.
- **Fix:** `readJournal`/`sqlTagsOnDisk` take a directory; the orphan-file / dangling-entry / dense-idx + ascending-`when` tests run via `describe.each` over both engines.
- **Result:** 13 passed (was 10). Probe: a temporary `0099_probe_orphan.sql` made the guard fail, naming the file; the probe was removed.

### DB-09 [P3] `typecheck:sqlite` not in CI — CONFIRMED, FIXED

- `npm run typecheck:sqlite` exits 0 locally. Added as a blocking CI step after "Typecheck backend".

### T-02 [P2] drills advisory — PARTIALLY DISPROVEN

- The multi-device drill already has a separate blocking `sync-multidevice:` job, pinned by `dfp008-ci-gates.test.mjs`. The restore drill (`verify-restore-sync-state.mjs`) is still advisory only; it wasn't promoted (determinism unproven, needs live PostgreSQL) → BLOCKED.

### T-03 / F-02 [P2] sync correctness tested by source text — CONFIRMED, assessed only

- `sync-invariants.test.ts`: 83 `it` blocks with ~162 source-text assertions (the audit's 220/123 counts are stale). Only 3 behavioral sibling files exist (`claims-fww`, `idempotency`, `pull-cursor`), not ~5. No change made.

### T-04 [P2] Playwright e2e absent from CI — CONFIRMED, NOT FIXED

- The configs need a running stack (`baseURL :8081`) and installed browsers; an unproven gate was not added. See Phase 4 for the local e2e run.

### T-05 [P2] `npm audit` absent from CI — CONFIRMED, FIXED for backend

- Backend `npm audit --omit=dev --audit-level=high` → 0 vulnerabilities → blocking step. Root: 1 critical / 3 high → advisory step (see NEW-02 for the lockfile fix).

### T-06 [P2] audit-findings suite never runs — CONFIRMED, BLOCKED

- Excluded unless `API_BASE` is set, and CI never sets it. Needs a live-PostgreSQL run before it's added.

### T-07 [P2] no testTimeout; dfp029 flake — CONFIRMED, FIXED (targeted)

- Earlier evidence: a 5000 ms timeout in a full run vs 355 ms alone; the test does a bounded synchronous walk of three source trees — slow disk, not a hang. Fix: a 30 s timeout on that one test only (a global timeout would hide real hangs). 4 passed.

### T-08 [P2] Rust tests only spot-checked in CI — CONFIRMED, FIXED

- Locally `cargo test` → 104 lib + 7 bin passed, 0 failed. Added a full `cargo test` step to the `desktop-windows` job.

### T-09 [P2] SQLite suite never runs in CI — CONFIRMED, FIXED

- Added a blocking "Backend suite on SQLite (T-09)" step running `npm run test:sqlite`; it needs no services.

### T-10 [P3] CI-gate self-tests circular — CONFIRMED, kept as a checklist

- `dfp008-ci-gates.test.mjs` still 3/3 after the edits; `ci.yml` parses as valid YAML.

### N-01 caveats [P2] integrity tool — CONFIRMED, partly fixed

- Added `"integrity:sqlite": "node scripts/reconcile-integrity-sqlite.mjs"` to `backend/package.json`; a smoke run on a missing DB prints a JSON error and exits non-zero, as designed.
- Ledger-balance check NOT added: the PostgreSQL original lacks it too and the invariant is defined nowhere; a guessed check would raise false alarms on customer data.

**Files changed:** `vitest.config.ts` (T-01); `backend/tests/migrations-journal-guard.test.ts` (DB-06); `src/dfp029-credentials.test.ts` (T-07); `.github/workflows/ci.yml` (DB-09, T-05, T-08, T-09); `backend/package.json` (N-01 script).

---

# SESSION 2 CHECKPOINT (2026-10-11) — continuation after usage-limit stop

Resumed from the exact working tree (HEAD unchanged `729fcd98`; 70 modified + ~30 untracked files from Session 1). **No product code reverted, no stash/reset, customer `motard.db` untouched (mtime still 2026-10-10 16:50:19).** Verdict remains **NOT READY**.

## Database architecture proven before any DB work (per owner instruction)

- **Production/hub engine: PostgreSQL** (`orm/engine.ts:19-21`, `backend/.env` `DATABASE_URL`). **Desktop engine: SQLite** — `stack.rs:477` spawns the sidecar with `DB_ENGINE=sqlite` + `SQLITE_PATH=<root>\data\motard.db` and **removes `DATABASE_URL`** (`:490`). Dual-engine: every repo has a `Postgres*` and `Sqlite*` twin.
- **Why PG + initdb:** the SQLite suite mirrors customer installs (ran green: 914/0). The PG suite is the cloud-reference gate; local PG was down, so I used the repo's **own bundled PostgreSQL 17.10** (`desktop/retired-postgres/resources-postgres/bin`) to build a **throwaway cluster in scratch** (`$TMPDIR/rv-pgdata2`, port **56438**, `--locale=C` per `build-pgdata-template.mjs:112`), DB **`erp_test`**. Every DB command carried an explicit `DATABASE_URL=…56438/erp_test`; `vitest.config.ts:11-16` preserves an explicit env `DATABASE_URL` over `.env`, so the `localhost:5432/erp` fallback could never fire. **Nothing listens on 5432** anyway.
- **Isolation proven:** SQLite tests force a per-run temp DB (`vitest.config.ts:21-25`); `SQLITE_PATH` is never set in `.env`/`.env.test`; customer `motard.db` mtime unchanged. PG work only ever hit the throwaway `erp_test`.

## Completed this session (all locally verified)

| Task                                               | Result       | Evidence                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SS-01** settings-sync `id`/`tenant_id` trust gap | **FIXED**    | `upsertSection` interpolated the section name into SET with NO allowlist (`ALLOWED_SECTIONS` was dead code). Added `assertAllowedSection` to **both** repos + `drive` to the list. New test `backend/tests/sqlite/settings-section-allowlist.test.ts` — RED 3/4 fail → **GREEN 4/4** (refuses `id`/`tenant_id`/unknown; accepts all 8 legit sections incl. `drive`). |
| **seroval** critical (RV-03)                       | **FIXED**    | Added `"overrides":{"seroval":"^1.6.9"}` to root `package.json` (transitive via `@tanstack/router-core`, semver-compatible). `npm install` → seroval 1.5.6→**1.6.9**; root audit **14→13, critical gone** (8 high remain, all dev-only). Typecheck 0, `vite build` ✓.                                                                                                |
| **RV-01** two frontend timeouts                    | **FIXED**    | Targeted 30 s timeout on `toast-semantics.test.ts` + `UserPickerPage.test.ts` (same pattern as dfp029). Frontend **353/353** (was 2 failed).                                                                                                                                                                                                                         |
| **RV-02** fx-cogs PG-only test                     | **FIXED**    | Gated with `isSqliteRun` → visible skip (FIN-09). Under sqlite: 1 pass / 1 skip. (Note: `databaseReachable()` can't detect the shim — the engine flag is the correct gate.)                                                                                                                                                                                          |
| **IPC ACL test in CI**                             | **FIXED**    | `node --test desktop/scripts/ipc-acl-wiring.test.mjs` added to **both** `build` and `desktop-windows` jobs. YAML valid; dfp008 self-test 3/3; ACL test 4/4.                                                                                                                                                                                                          |
| **RLS proven live (SEC-03)**                       | **RESOLVED** | Booted bundled PG, `db:migrate` + `apply-rls.mjs`, verified **as `app_user` (NOBYPASSRLS)**: `verify-rls: OK — 51 business tables…`. Behavioral proof: T1 sees 1 invoice, T2 sees 1, no-context sees **0**, cross-tenant write **rejected by RLS**.                                                                                                                  |

## New defects found & fixed this session

- **RV-03a (P1, real):** `enable-rls.sql` §4 blanket-looped `ENABLE+FORCE RLS` over every table with a `tenant_id` column — `revoked_tokens` has a _nullable_ `tenant_id`, so it got FORCE RLS with **no policy** → the denylist returned **0 rows** for the app role → `isRevoked(jti)` always "not revoked" → **revoked JWTs stayed valid until expiry**. This re-broke the exact P0 that migration `20260927` fixed. Fixed: excluded `revoked_tokens` from the loop + added an explicit repair `DISABLE`. [live-verified]
- **RV-03b (P2):** `verify-rls.mjs` expected `tenant_isolation=36` but the canonical `enable-rls.sql` array holds 42 entries − dropped `party_balances` = **41**. Stale count; the 5 "extra" tables (attachments, audit_logs, ledger_entry_archive, sync_device_authorized_users, yearly_party_summaries) all carry NOT NULL `tenant_id` and are in the canonical list. Corrected 36→41 with the derivation documented. [live-verified]

## Full-suite results this session (all executed, summary lines read)

- Backend SQLite: **914 passed / 40 skipped / 0 failed** (164 files)
- Backend PostgreSQL (live, `erp_test`@56438, `--locale=C`): **958 passed / 0 failed** (165 files)
- Frontend: **353 passed / 353** (80 files)
- Cargo `--lib`: **104 passed / 0 failed**
- Desktop scripts: **31 passed / 0 failed**
- RLS (as app_user): **OK**
- Root + backend `tsc --noEmit`: **0 errors**; `vite build`: **✓**

## BLOCKED / remaining

1. **API E2E (`npm run test:api`)** — root-caused but **NOT green**. After correctly completing setup (tenant + `setup_wizard_state.is_completed=true` + seeded admin), login works and the suite reaches **20 passed / 20 failed**. The 20 failures are **missing fixture data, not product defects**: `comprehensive-api.mjs:62-66` hardcodes fixture UUIDs (`SID/CID/FID/CCOL/RID`) that **no committed seed creates** — `seed-test-baseline.mjs` uses different IDs (`…b001`) and `seed-test-admin.mjs` only makes a user. The suite assumes a pre-seeded dataset that the CI flow also doesn't produce from a bare migrate. **To finish:** either add a fixture seed producing those exact IDs, or confirm CI's `erp_test` is pre-seeded another way. **This is an open finding, not a pass.**
2. **Lint** — 617 pre-existing prettier errors across 88 files, **none from my edits** (my files absent from the offender list). Awaiting owner decision: `eslint --fix` (formatting-only) vs. document.
3. **Terminal consent-gated** — a `taskkill` to clear a stale server on :8080 was blocked pending consent; the E2E server processes need manual cleanup (`taskkill /F /PID <pid>` on the :8080 listener) before a clean re-run.
4. **External (unchanged):** installer durability drills (DT-04), live Google Drive OAuth round-trip, consent-screen publishing, updater signing key (DT-01), RLS under the real hub `app_user` against the actual hub DB (proven here only on the throwaway cluster).

## Files edited this session (none reverted; customer data untouched)

- `backend/src/infrastructure/repositories/PostgresSettingsRepository.ts` + `sqlite/SqliteSettingsRepository.ts` (SS-01 allowlist)
- `backend/tests/sqlite/settings-section-allowlist.test.ts` (new, SS-01)
- `package.json` (seroval override)
- `src/presentation/hooks/__tests__/toast-semantics.test.ts`, `src/components/auth/UserPickerPage.test.ts` (RV-01 timeouts)
- `backend/tests/fx-cogs-replay-pin.test.ts` (RV-02 gate)
- `.github/workflows/ci.yml` (IPC ACL gate ×2 jobs)
- `backend/scripts/verify-rls.mjs` (36→41), `backend/src/infrastructure/orm/rls/enable-rls.sql` (revoked_tokens exemption + repair)
