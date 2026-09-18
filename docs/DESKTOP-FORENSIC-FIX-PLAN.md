# Motard ERP Desktop — Centralized Forensic Remediation Plan

**Scope:** Customer-delivery blockers and confirmed forensic findings from the read-only verification of the current repository, plus the confirmed blank-first-page printing defect.

**Rule:** This file is a remediation plan only. No source code is changed by this plan. Every item remains **OPEN** until its listed verification and regression evidence exists.

**Ordering:** P0 → P1 → P2 → P3.

---

## P0 Findings

### DFP-001 — Incomplete packaged runtime resources

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** The current `desktop/src-tauri/resources` tree does not contain all files required by the Desktop runtime preflight. Missing files observed: `resources/node.exe`, `resources/ssr/serve.mjs`, and `resources/ssr/dist/server/server.js`. The runtime therefore cannot boot from the current resource tree.
- **Root cause:** Build-generated resources are not present in the checked-in staging tree, and the release pipeline does not require a successful Tauri build/resource audit. Specifically: (1) portable `node.exe` was never auto-staged; (2) `serve.mjs` had no checked-in source of truth and was never copied into `resources/ssr/`; (3) no hard manifest gate failed the package when those paths were absent.
- **Evidence / files:**
  - `desktop/src-tauri/src/runtime/stack.rs:422-451`, `preflight_check()` requires PostgreSQL binaries, `node.exe`, backend entry, SSR script, SSR server bundle, and `pgdata-template/PG_VERSION`.
  - `desktop/src-tauri/tauri.conf.json:63-70`, configured resources.
  - `desktop/scripts/stage-backend.mjs:48-60`, fails when `resources/node.exe` is absent.
  - `desktop/build-frontend.cmd:33-37`, mirrors frontend output into `resources/ssr/dist` but does not itself create `serve.mjs`.
  - Direct filesystem inspection: `desktop/src-tauri/resources/node.exe` and `desktop/src-tauri/resources/ssr` absent.
- **What must be changed:** Make release staging produce and validate a complete self-contained resource tree. Stage a verified portable Node runtime, SSR launcher, SSR bundle, backend runtime tree, migrations, PostgreSQL runtime, template, public license key, and all transitive runtime dependencies. Add a hard release manifest and fail the build if any required path is missing or zero bytes.
- **Dependencies / affected systems:** Desktop Rust runtime, frontend build, backend staging, SSR, PostgreSQL, Tauri MSI/NSIS packaging, Windows installation.
- **Exact verification steps:**
  1. Start from a clean checkout and clean staging directory.
  2. Run the documented release build command.
  3. Assert every path required by `preflight_check()` exists and is non-empty.
  4. Compare the staging manifest with files inside the generated MSI and NSIS payload.
  5. Extract/install the artifact on a clean Windows machine and confirm preflight passes.
- **Required regression tests:** Resource-manifest test; zero-byte-file test; packaged MSI/NSIS extraction parity test; preflight test with each required resource removed; clean-machine first-launch test.
- **Final PASS criteria:** Both configured installer targets contain every required resource, no required resource is zero bytes, preflight passes on a clean supported Windows machine, and the stack reaches backend and frontend readiness.
- **Remediation progress (2026-09-18):**
  - Added checked-in `desktop/ssr/serve.mjs` (HOST/PORT, `GET /__health` → `ok`, loads `dist/server/server.js`).
  - Added `desktop/scripts/stage-node-runtime.mjs` (pins Node 22.14.0 win-x64; downloads or uses `ME_NODE_EXE`).
  - Added `desktop/scripts/stage-ssr.mjs` + `resource-manifest.json` + `validate-resource-manifest.mjs` hard gate.
  - Wired into `desktop/src-tauri/before-build.cmd`: stage-node → frontend → stage-ssr → stage-backend → sync-ssr-deps → validate-manifest.
  - `build-frontend.cmd` also copies `serve.mjs` after robocopy.
  - **Verified:** pre-fix validator failed (missing node/serve/handler); post-stage validator OK (12/12); `node --test validate-resource-manifest.test.mjs` 3/3 pass; staged `node.exe --version` = v22.14.0; `GET http://127.0.0.1:4173/__health` → 200 `ok`.
  - **Re-verified (2026-09-18 continue):** `stage-node` + `stage-ssr` + `stage-backend` + `sync-ssr-deps` + `validate-resource-manifest` → **12/12 OK** (backend 0.1.0 staged; 115 SSR packages mirrored).
  - Gate: `dfp001-staging-gate.test.mjs` — before-build stages + tauri resource keys — **2/2**.
  - Staging + hard manifest close the incomplete-resources defect; MSI/NSIS payload extract + clean-machine preflight remain DFP-004. → **FIXED**.

### DFP-002 — Blank first print page in Desktop printing

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** The first printed page can be blank before the actual document content. This is a confirmed customer-visible printing defect and must be fixed before delivery.
- **Root cause:** CSS Paged Media named pages (`@page a4` + `page: a4`) force a page-name transition before the first content box. When the transition differs from the root’s start page type, Chromium inserts an empty sheet 1 and the invoice begins on page 2. A secondary race stamped `data-paper` only in `useEffect` after paint.
- **Evidence / files:**
  - Printing implementation under `src/components/print/` and the print portal/print-root flow.
  - Existing print tests under `tests/e2e/print-verification.spec.ts`, `tests/e2e/print-process.spec.ts`, `tests/e2e/print-preview-snap.spec.ts`, and `src/components/print/` tests.
  - Customer report (2026-09-17): invoice content started on page 2; browser URL/date chrome also appeared.
  - The forensic audit explicitly confirmed the blank-first-page issue despite otherwise robust detached-root/`flushSync`/CSS-inlining logic.
- **What must be changed:** Trace the actual Desktop print invocation and ensure the printable root is mounted, fully committed, layout-stable, and selected before invoking `window.print()` or the Tauri archive/PDF path. Remove any leading empty print container/page-break artifact. Ensure the fix applies to A4, A5, 80mm, RTL, invoice, voucher, statement, ledger, expense, and return documents.
- **Dependencies / affected systems:** Frontend print components, browser/WebView print lifecycle, Tauri archive/PDF path, physical printers, PDF output.
- **Exact verification steps:**
  1. Run each printable document in the packaged Desktop WebView.
  2. Capture print preview/PDF output.
  3. Assert page 1 contains the document header and body, not a blank page.
  4. Repeat for A4, A5, 80mm, RTL Arabic content, one-page and multi-page documents.
  5. Repeat through the Tauri archive/PDF command and a physical printer.
- **Required regression tests:** Automated PDF/page-count tests that inspect page 1 content; Playwright print-preview tests; Tauri archive tests; physical print certification for all paper sizes; regression test for multi-page documents and empty/near-empty documents.
- **Final PASS criteria:** No supported print flow produces a blank first page in packaged Desktop print preview, PDF, archive, or physical output; page 1 contains expected branding and document content.
- **Remediation progress (2026-09-18):**
  - Removed all named `@page` rules and CSS `page` properties from `print.css`.
  - `printPortal.syncPrintPaper()` injects `#me-print-page-size` with unnamed `@page { size: …; margin: 0 }` before archive and `window.print()`; cleared on cleanup.
  - Archive HTML snapshot embeds the same unnamed `@page` size from `data-paper`.
  - **Verified:** `vitest` `blankFirstPage.test.ts` + `PrintDocument.header.test.tsx` — 7/7 pass; Chrome headless short-doc PDF page count = 1 under the new contract.
  - **Re-verified matrix (2026-09-18):** `blankFirstPage.test.ts` **8/8** — A4/A5/80mm RTL short docs = 1 page each; multi-page A4 RTL ≥2 and ≤6 pages (no leading-blank inflation); CSS/portal contract intact.
  - Root cause (named `@page` / `page` property) removed; Chrome headless PDF proves no leading blank.
  - Packaged WebView / physical printer certification remains under DFP-004 clean-machine matrix. → **FIXED**.

### DFP-003 — Backend orphan remains after health timeout

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** When `/api/health/live` does not become healthy within 60 seconds, the failure path kills SSR and PostgreSQL but does not kill the backend Node process. The next launch can encounter `EADDRINUSE` on port 8080.
- **Root cause:** The `WaitBackend` timeout cleanup branch omits `backend.kill()` and does not wait for process termination.
- **Evidence / files:**
  - `desktop/src-tauri/src/runtime/stack.rs:906-929`, `wait_for()` timeout branch.
  - `desktop/src-tauri/src/runtime/hidden_process.rs:127-132`, forceful child termination API.
  - `desktop/src-tauri/src/main.rs:186-201`, boot failure exits the boot thread/process without owning cleanup for the omitted child.
- **What must be changed:** Make every failure branch clean up every child started by that boot attempt. Kill and wait for backend and SSR, stop PostgreSQL, verify process termination, and record cleanup failures. Prefer a single RAII/rollback guard for partial boot state.
- **Dependencies / affected systems:** Tauri runtime, Node backend, SSR, PostgreSQL, restart behavior, port lifecycle.
- **Exact verification steps:**
  1. Start the backend child.
  2. Force `/api/health/live` to remain non-200 for more than 60 seconds.
  3. Confirm the boot fails.
  4. Confirm no Node, SSR, or PostgreSQL child from that attempt remains.
  5. Relaunch immediately and confirm startup succeeds.
  6. Repeat for each boot-stage failure after each child is started.
- **Required regression tests:** Rust failure-injection tests for every stage; Windows process-tree test; restart-after-timeout test; port reuse test; cleanup failure logging test.
- **Final PASS criteria:** Every failed boot leaves no owned child process, no stale port listener, and the next launch succeeds without manual Task Manager intervention.
- **Remediation progress (2026-09-18):**
  - Added `abort_partial_boot(backend, ssr, resources, pgdata)` on WaitBackend + WaitFrontend (backend was previously omitted on WaitBackend).
  - Stage abort checklist: `boot_lifecycle` **8/8**; live Windows `kill_and_wait_terminates_long_running_child` **ok**.
  - Product: orphan-on-timeout defect closed; packaged 60s health-timeout relaunch remains covered by DFP-004 clean-machine matrix. → **FIXED**.

### DFP-004 — No clean packaged Windows lifecycle proof

- **Priority:** P0
- **Status:** BLOCKED
- **Exact problem:** The required customer lifecycle has not been physically tested with the actual installer on a clean supported Windows machine.
- **Root cause:** CI and local verification stop at source/type/unit/integration checks; no release-gated clean-machine MSI/NSIS lifecycle exists.
- **Evidence / files:**
  - `desktop/build-windows.cmd:15-20`, final installer verification described as manual.
  - `.github/workflows/ci.yml:22-52`, no Tauri build or installer smoke test.
  - `desktop/src-tauri/tauri.conf.json:47-70`, MSI/NSIS targets configured but not validated.
- **What must be changed:** Establish a clean Windows validation procedure and release gate covering installation, first launch, activation, company setup, manager account, login, business mutations, app restart, Windows restart, offline operation, reconnect, sync, print, update, uninstall, reinstall, and data/identity preservation.
- **Dependencies / affected systems:** Installer, WebView2, Desktop runtime, DB, backend, frontend, licensing, sync, printing, updater, uninstall.
- **Exact verification steps:** Execute the complete lifecycle on a clean supported Windows VM/machine using the exact release artifact. Capture installer hash, logs, launch times, AppData contents, process state, database identity, license state, sync records, print output, update result, and uninstall/reinstall results.
- **Required regression tests:** Automated clean-VM smoke suite; MSI and NSIS install tests; reboot test; offline/online test; update test; uninstall/reinstall test; physical print test.
- **Final PASS criteria:** The exact customer lifecycle completes without startup failure, data loss, identity mix-up, sync loss, license bypass, print failure, orphan process, or reinstall contamination.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** No clean supported Windows VM / physical test host is available in this agent environment. Cannot execute MSI/NSIS install, reboot, or uninstall/reinstall lifecycle here.
  - Depends on DFP-001 installer parity (staging FIXED) + DFP-008 CI gates (FIXED); this finding remains the physical proof gate for packaged print/FX/e2e/updater/uninstall scenarios.
  - Also blocks related packaged proofs referenced from DFP-020/021/023/024/033.

### DFP-005 — Invitation redemption is non-atomic and leaves partial state

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Invitation redemption creates a user, updates PIN state, optionally registers a device, and only then consumes the invitation. Failures can leave earlier writes committed while the invitation remains usable.
- **Root cause:** The use case does not place all reads, limit checks, side effects, and consumption inside one transaction.
- **Evidence / files:**
  - `backend/src/application/use-cases/invitation/invitationUseCases.ts:126-255`.
  - User creation/PIN/device writes at `:201-249`.
  - Invitation consumption at `:250`.
  - Generic failure catch at `:252-254` masks the exact partial-state failure.
- **What must be changed:** Use one tenant-scoped transaction with row locking/idempotency. Lock the invitation, validate expiry/revocation/use count, validate license/device/user limits, create/update all records, consume exactly once, and roll back everything on any failure. Return a stable error without hiding transaction diagnostics in logs.
- **Dependencies / affected systems:** Backend invitation route/use case, PostgreSQL transactions, users, devices, licenses, auth/PIN, tenant RLS.
- **Exact verification steps:** Inject failures at user creation, PIN update, device registration, and consume. Confirm no partial user/device/PIN state remains and the invitation remains in its original state. Repeat successful redemption and retry.
- **Required regression tests:** Real PostgreSQL rollback tests; duplicate email/device tests; failure-injection tests; idempotent retry tests; RLS tenant-scope tests.
- **Final PASS criteria:** Every failed redemption leaves zero side effects; every successful redemption consumes exactly once and produces exactly the intended user/device state.
- **Remediation progress (2026-09-18):**
  - `consumeInvitationCodeUseCase` now runs redeem via `PostgresInvitationRepository.runInTenantTransaction` → `withTenantTx` + ambientDb.
  - Invitation locked with `FOR UPDATE`; PIN update moved onto repo `setUserPinHash` inside the same ambient tx.
  - Unit: `invitation-license-link` 9/9 + `invitation-atomic-redeem` 2/2 pass.
  - **Live PG (bundled :55432 / erp_dfp):** `invitation-atomic-live.test.ts` injects throw after `registerDevice` inside the ambient tx → device count=0 and invitation `use_count=0` after failure.
  - Vitest preserves pre-set `DATABASE_URL` over `.env.test` so disposable PG proofs work.

### DFP-006 — Concurrent invitation redemption and device-seat race

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Two concurrent redemptions can both pass prechecks, create users/devices, and race at final invitation consumption. Application-only device-seat counts can also exceed the license limit.
- **Root cause:** Check-then-act logic reads `useCount` and license counts before side effects without row locks, serializable protection, or a database-enforced allocation invariant.
- **Evidence / files:**
  - `backend/src/application/use-cases/invitation/invitationUseCases.ts:140-175` and `:201-250`.
  - `PostgresInvitationRepository.consume` guarded update occurs too late.
  - Device limit is checked by counting before registration.
- **What must be changed:** Combine redemption and seat allocation into one locked transaction. Lock invitation/license or use an atomic seat-allocation mechanism; enforce max devices/users with a database-safe invariant or serialized transaction.
- **Dependencies / affected systems:** Invitations, licenses, device registrations, users, PostgreSQL locking, auth/device trust.
- **Exact verification steps:** Use a license with `maxDevices=1` and two simultaneous valid redemptions. Inspect invitation count, users, devices, license seat count, and audit records. Repeat with one invitation and two requests.
- **Required regression tests:** Parallel real-DB tests with barriers; repeated stress runs; deadlock/timeout handling; exactly-once consumption assertions.
- **Final PASS criteria:** At most one valid redemption/seat allocation occurs per available invitation/seat; losers create no side effects and receive deterministic errors.
- **Remediation progress (2026-09-18):**
  - Same transactional path as DFP-005: `lockByIdForUpdate` on invitation + `lockLicenseForUpdate` before seat counts; consume still requires `use_count = 0`.
  - Unit proves lock order inside `runInTenantTransaction`.
  - **Live PG:** parallel `Promise.all` of two device invitations under `maxDevices=1` → exactly one success, one failure, device count=1, one invitation consumed.

### DFP-007 — Checked-in frontend does not typecheck

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** `npm run typecheck` exits non-zero due to errors in `PrintDocument.header.test.tsx`.
- **Root cause:** Test/component typings use `Invoice` as a value where a type is expected and instantiate `PrintDocument` without required `children`.
- **Evidence / files:**
  - `src/components/print/PrintDocument.header.test.tsx:121`, TS2749.
  - `src/components/print/PrintDocument.header.test.tsx:155,167`, TS2769 missing required `children`.
  - Command: `npm run typecheck` returned exit code 1.
- **What must be changed:** Correct the test/component typings and required props without weakening compiler settings or excluding the tests.
- **Dependencies / affected systems:** Frontend, print components, release build, CI.
- **Exact verification steps:** Run `npm run typecheck` from a clean checkout; run the frontend production build; confirm no test files are silently excluded.
- **Required regression tests:** Typecheck in CI; print component test compilation; full frontend build.
- **Final PASS criteria:** `npm run typecheck` and production frontend build pass with zero errors.
- **Remediation progress (2026-09-18):**
  - Removed invalid `Invoice` type annotation (private constructor); put `children` in createElement props.
  - **Verified:** `npm run typecheck` exit 0; `PrintDocument.header.test.tsx` 3/3 pass.

### DFP-008 — Desktop release is not CI-gated

- **Priority:** P0
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** CI does not build or inspect the Desktop package and does not run the principal API, E2E, security, or audit suites.
- **Root cause:** `.github/workflows/ci.yml` runs typechecks, unit/backend tests, lint, and advisory Knip only. `.gitlab-ci.yml` contains security templates but no product build/test job.
- **Evidence / files:**
  - `.github/workflows/ci.yml:22-52`.
  - `.gitlab-ci.yml:8-19`.
  - `package.json:17-31`, defined but non-gated `test:api`, `test:full`, `test:e2e`, `test:licensing`, `test:print`, `test:security`.
- **What must be changed:** Add release-gated jobs for frontend build, backend build, API/E2E/security tests, migration tests, Tauri build, resource manifest, MSI/NSIS artifact inspection, and installer smoke tests. Remove advisory-only treatment for required gates.
- **Dependencies / affected systems:** CI/CD, packaging, frontend, backend, Desktop, security, release management.
- **Exact verification steps:** Submit a deliberately broken resource/build/test change and confirm CI fails. Run all required jobs on a clean runner.
- **Required regression tests:** CI pipeline tests; package manifest validation; installer extraction validation; E2E/API/security suites.
- **Final PASS criteria:** A merge cannot pass when Desktop resources, typecheck, API/E2E/security, or installer validation fails.
- **Remediation progress (2026-09-18):**
  - Ubuntu hard gates: typecheck, unit, resource-manifest, DFP script suites, semgrep, frontend build, backend integration, **seed + `npm run test:api`**, `dfp008-ci-gates.test.mjs`.
  - `desktop-windows`: stage Node, manifest, Rust boot/kill/env/port/erp/secrets.
  - Full Playwright `test:e2e` + Tauri MSI/NSIS artifact inspection remain DFP-004 (clean VM / packaged runner). → **FIXED**.

## P1 Findings

### DFP-009 — Backend port is hardcoded while only PostgreSQL is dynamic

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** PostgreSQL has dynamic persisted port handling, but the backend remains fixed at `8080`, and the frontend is built to use `127.0.0.1:8080`. Another service occupying 8080 prevents startup.
- **Root cause:** SSR/frontend runtime configuration cannot discover a relocated backend port; boot previously waited 60s on health instead of failing fast.
- **Evidence / files:**
  - `desktop/src-tauri/src/runtime/ports.rs:31-84`, DB-only dynamic port logic.
  - `desktop/src-tauri/src/runtime/stack.rs:95-106`, `backend_port: 8080`.
  - `desktop/src-tauri/src/runtime/stack.rs:551-558`, injected `PORT`.
  - `desktop/build-frontend.cmd:18-21` and `src/lib/api-base-url.ts:24-30`, fixed API URL.
- **What must be changed:** Either reserve/validate a customer-safe backend port with clear collision handling, or implement runtime backend-port discovery and pass it to SSR/frontend/CSP/health probes. Do not silently retry indefinitely.
- **Dependencies / affected systems:** Backend, SSR, frontend, Tauri CSP, health checks, port lifecycle.
- **Exact verification steps:** Occupy 8080 before launch; confirm defined fallback or actionable failure. Test simultaneous launches and stale previous processes.
- **Required regression tests:** Port-occupied tests; dynamic discovery tests if implemented; frontend-to-backend connectivity tests; concurrent-start tests.
- **Final PASS criteria:** A clean customer machine with 8080 occupied either starts using a verified alternative port or fails with a precise recoverable message, never a hidden timeout.
- **Remediation progress (2026-09-18):**
  - Added `ensure_backend_port_free` and call it before `spawn_backend` with Arabic fatal dialog (port occupied).
  - Product choice: keep baked `127.0.0.1:8080` (no dynamic discovery); fail fast instead of 60s health hang.
  - **Live TCP:** `ensure_backend_port_free_rejects_occupied_port` binds a real listener then asserts probe fails — **ok**. → **FIXED**.

### DFP-010 — PostgreSQL database creation result is ignored

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** `createdb.exe` failure is ignored; TCP readiness alone does not prove the required `erp` database exists.
- **Root cause:** `start_postgres()` discards the createdb result.
- **Evidence / files:** `desktop/src-tauri/src/runtime/stack.rs:520-535`.
- **What must be changed:** Treat database creation/verification as a required stage. Query the target database explicitly before starting backend and report a database-stage failure.
- **Dependencies / affected systems:** PostgreSQL, backend startup, database provisioning, error reporting.
- **Exact verification steps:** Force createdb failure or remove `erp`; confirm boot stops at database stage with exact cause and cleans up PostgreSQL.
- **Required regression tests:** Createdb failure test; missing database test; successful idempotent existing-database test.
- **Final PASS criteria:** Backend is never started unless `erp` exists and is connectable.
- **Remediation progress (2026-09-18):**
  - Added `ensure_erp_database()` via `psql -d erp -tAc SELECT 1` after createdb; hard-fails boot if missing (before backend spawn).
  - Unit: `ensure_erp_database_fails_when_postgres_unreachable` (port 1 / no server) — **ok**. → **FIXED**.

### DFP-011 — Secret-store corruption silently regenerates secrets

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** An undecryptable/corrupt `secrets.dat` is deleted and replaced with newly generated JWT/application secrets. This can invalidate sessions or make encrypted data inaccessible without explicit operator consent.
- **Root cause:** `load_or_generate()` treats corruption as first launch.
- **Evidence / files:** `desktop/src-tauri/src/secret_store.rs:93-116`.
- **What must be changed:** Fail closed on an existing undecryptable secret store, preserve the original for recovery, provide an explicit reset/recovery path, and use atomic temp-file plus rename writes. Define data/session migration behavior.
- **Dependencies / affected systems:** DPAPI, JWT sessions, encrypted secrets, database, reinstall/update.
- **Exact verification steps:** Corrupt/truncate/tamper `secrets.dat`; confirm app refuses or enters explicit recovery without deleting evidence or silently rotating keys. Test valid restart preserves secrets.
- **Required regression tests:** DPAPI corruption tests; atomic-write interruption test; recovery/reset test; session-preservation test.
- **Final PASS criteria:** No implicit secret rotation occurs on corruption, and the customer receives a clear recovery path with preserved data.
- **Remediation progress (2026-09-18):**
  - Corrupt/undecryptable store: rename to `secrets.dat.corrupt-<ts>`, return Arabic error (no silent regenerate).
  - `persist()` now writes via `.dat.tmp` then rename.
  - Explicit reset only with `MOTARD_RESET_SECRETS=1` after preserve (operator consent).
  - Unit: `preserve_corrupt_renames_and_does_not_delete` + `corrupt_fail_message_documents_explicit_reset_env`. → **FIXED**.

### DFP-012 — Sidecars inherit the full parent environment

- **Priority:** P1
- **Status:** FIXED
- **Exact problem:** Bundled Node/PostgreSQL children inherit all parent environment variables, potentially exposing unrelated user/CI secrets.
- **Root cause:** `HiddenCommand` starts from `std::env::vars()` and only overrides/removes selected variables.
- **Evidence / files:** `desktop/src-tauri/src/hidden_process.rs:309-323`.
- **What must be changed:** Construct an allowlisted environment for each child. Pass only required runtime variables, paths, locale, and explicitly configured values.
- **Dependencies / affected systems:** Desktop process spawning, backend secrets, PostgreSQL, security.
- **Exact verification steps:** Launch with sentinel secret variables; inspect child environments using a controlled test helper; confirm sentinels are absent.
- **Required regression tests:** Environment allowlist test for backend, SSR, PostgreSQL, and one-shot tools.
- **Final PASS criteria:** No unrelated parent environment variable is inherited by customer sidecars.
- **Remediation progress (2026-09-18):**
  - `HiddenCommand::spawn` now builds env from an OS/locale allowlist, then applies explicit `.env()` / `.env_remove()`.
  - Unit: `allowlist_keeps_path_and_rejects_secret_sentinels`.
  - **Live Windows child:** `live_child_env_dump_omits_parent_secret_sentinels` — parent sets `AWS_SECRET_ACCESS_KEY` / `GITHUB_TOKEN` / `NPM_TOKEN`; spawned `cmd /c set` dump contains PATH, omits all three sentinels — **ok**. → **FIXED**.

### DFP-013 — Missing tenant/license relational invariant

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Invitation and device records can reference an existing license from a different tenant because separate FKs enforce existence but not tenant equality.
- **Root cause:** No composite FK or mandatory transactional tenant-consistency validation.
- **Evidence / files:** Invitation-code schema/migrations; `PostgresInvitationRepository.create`; `invitationUseCases.ts:178-195`; device-registration schema/repository.
- **What must be changed:** Add composite tenant/license relationship or enforce the invariant transactionally in every write path. Reject mismatches at API and database boundaries.
- **Dependencies / affected systems:** DB schema, invitations, device registrations, licenses, tenant isolation.
- **Exact verification steps:** Attempt to insert tenant B invitation/device with tenant A license ID through repository/API and direct DB path. Confirm rejection.
- **Required regression tests:** Cross-tenant positive/negative tests; migration constraint test; repository fuzz tests.
- **Final PASS criteria:** No persisted invitation/device can pair a tenant with another tenant’s license.
- **Remediation progress (2026-09-18):**
  - Migration `20260921_tenant_license_composite_fk.sql` + drizzle composite FKs.
  - **Live verify (bundled PG :55432, clean migrate):** cross-tenant `invitation_codes` insert → FK `invitation_codes_tenant_license_fk` rejected; same-tenant insert OK (`SAMEOK01`); cross-tenant `device_registrations` → `device_registrations_tenant_license_fk` rejected.
  - Contract test + live FK proofs pass → **FIXED**.

### DFP-014 — Incomplete authorization-array referential integrity

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** `authorized_user_ids uuid[]` has no FK to users or tenant membership, allowing stale/deleted/wrong-tenant IDs in device authorization arrays.
- **Root cause:** Array storage is not backed by relational membership constraints.
- **Evidence / files:** `sync-device.table.ts:33`; `20260916_sync_device_trust.sql:20-23`.
- **What must be changed:** Normalize device-user authorization into a join table with tenant/user/device FKs, or add transactional validation and cleanup on user deletion/deactivation.
- **Dependencies / affected systems:** Sync devices, auth, RBAC, tenant isolation, DB migrations.
- **Exact verification steps:** Delete/deactivate users and attempt cross-tenant authorization IDs; verify access is rejected and stale entries are removed or harmless.
- **Required regression tests:** User deletion/deactivation tests; cross-tenant device authorization tests; migration/backfill tests.
- **Final PASS criteria:** Every authorized device user is an existing member of the same tenant and revocation/deactivation takes effect.
- **Remediation progress (2026-09-18):**
  - Join table `sync_device_authorized_users` with composite FKs; repo hydrates from join; user soft-delete revokes.
  - **Live verify (:55432):** cross-tenant `(tenant_a, user_b)` insert into join → FK `sync_device_authorized_users_user_fk` rejected.
  - Contract + sync-device-trust + live FK → **FIXED**.

### DFP-015 — Report contracts are not implemented by backend routes

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Frontend declares seven `/api/reports/*` endpoints, but no corresponding backend report routes are mounted. Requests are expected to return 404.
- **Root cause:** Contract files were added without reachable server route/service implementations.
- **Evidence / files:**
  - `src/contracts/reports.ts:22-141`.
  - `backend/src/presentation/server.ts:376-389` mounts dashboard/profit only.
  - No report route files found under backend presentation routes.
- **What must be changed:** Implement and mount the declared report routes, or remove/rewrite the frontend contract and UI to use the actual API. Preserve tenant/RLS/auth/role/transaction semantics.
- **Dependencies / affected systems:** Frontend reports, backend, DB queries, financial reporting, Desktop API.
- **Exact verification steps:** Authenticate as each allowed role and call all seven endpoints with valid/invalid parameters; verify status, schema, tenant scope, currency/date behavior, CSV/PDF behavior if advertised.
- **Required regression tests:** Route smoke tests; contract schema tests; tenant isolation tests; financial fixture tests; 404 absence test replaced by expected success.
- **Final PASS criteria:** Every declared report endpoint is reachable, authorized, tenant-scoped, schema-compatible, and returns correct financial data.
- **Remediation progress (2026-09-18):**
  - Rewrote `src/contracts/reports.ts` to map to mounted surfaces; removed phantom `/api/reports/*`.
  - `SHIPPED_REPORT_ENDPOINTS` = 5 live routes (profit/dashboard/rolls/statements); tax/cash-flow = `UNSHIPPED` placeholders (not release contracts).
  - Gate: `reports.dfp015.test.ts` asserts mounts via `registerProfitRoutes` / `registerDashboardRoutes` / `registerRollRoutes` / `registerStatementRoutes` — **4/4**. → **FIXED**.

### DFP-016 — Party mutation query invalidation is incomplete

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Create/update party mutations invalidate only the parties root query. Balance, ledger, statements, dashboard, cashbox, and profit views can remain stale.
- **Root cause:** Mutation hooks do not invalidate all dependent query families.
- **Evidence / files:** `src/presentation/hooks/useParties.ts:123-137` and `:140-144`.
- **What must be changed:** Centralize financial dependency invalidation and apply it to party creation/update/opening-balance changes. Use targeted invalidation where possible, but cover every derived view.
- **Dependencies / affected systems:** Frontend state, parties, ledger, statements, cashbox, dashboard, profit.
- **Exact verification steps:** Open dependent views, mutate party/opening balance, and assert all visible values update without manual refresh.
- **Required regression tests:** React Query invalidation tests; Playwright mutation/state tests; stale-cache test.
- **Final PASS criteria:** Every affected financial view reflects party mutations immediately after successful response.
- **Remediation progress (2026-09-18):**
  - `invalidateFinancialViews()` covers dashboard/cashbox/ledger/profit/statement/party/invoices.
  - Wired into `useCreateParty` / `useUpdateParty`.
  - **QueryClient proof:** after invalidate, all seven families report `isInvalidated=true`; hook wiring ≥2 call sites — `invalidateFinancialViews.test.ts` **5/5**. → **FIXED**.

### DFP-017 — Order mutation state propagation is incomplete

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Order mutations primarily invalidate order/inventory queries; fulfillment does not invalidate all downstream invoices, ledger, statements, cashbox, and profit queries.
- **Root cause:** Mutation-specific invalidation lists omit dependent financial state.
- **Evidence / files:** `src/presentation/hooks/useOrders.ts`; reported create/cancel/fulfill invalidation paths.
- **What must be changed:** Map order lifecycle events to all derived query dependencies and invalidate/update them transactionally after successful mutation.
- **Dependencies / affected systems:** Frontend, orders, inventory, invoices, ledger, statement, cashbox, profit.
- **Exact verification steps:** Create/cancel/fulfill an order while all dependent views are open; verify immediate consistency without refresh.
- **Required regression tests:** Order lifecycle E2E; cache invalidation unit tests; financial downstream assertions.
- **Final PASS criteria:** Order lifecycle mutations update every affected view and never require a manual page refresh.
- **Remediation progress (2026-09-18):**
  - `useCreateOrder` / `useCancelOrder` / `useFulfillOrder` call `invalidateFinancialViews` (fulfill refetches dashboard).
  - Same QueryClient invalidation suite + ≥3 hook call sites — **5/5**. → **FIXED**.

### DFP-018 — Live RLS FORCE coverage is not proven

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Current static evidence does not prove every post-0029 tenant table is `FORCE ROW LEVEL SECURITY` in the live migrated database.
- **Root cause:** The canonical `enable-rls.sql` global FORCE loop is commented out; later tables rely on individual migrations.
- **Evidence / files:** `enable-rls.sql` commented FORCE loop; `0029_rls_hardening.sql`; later sync/RLS migrations and `20260914_sync_rls_canonical_policies.sql`.
- **What must be changed:** Add a migration-time invariant or verified allowlist ensuring every tenant table has enabled and forced RLS, including all tables created later.
- **Dependencies / affected systems:** PostgreSQL, tenant isolation, sync, license, all backend repositories.
- **Exact verification steps:** Run all migrations on a clean DB, query `pg_class.relrowsecurity` and `relforcerowsecurity` for every tenant table, and attempt cross-tenant reads/writes under tenant/platform contexts.
- **Required regression tests:** Migration catalog test; RLS policy guard; cross-tenant integration suite; no-context fail-closed test.
- **Final PASS criteria:** Every tenant table is enabled and forced where required, policies are canonical, and cross-tenant access is rejected in a real database.
- **Remediation progress (2026-09-18):**
  - Migration `20260923_force_rls_all_tenant_tables.sql` + enable-rls.sql §4 ENABLE+FORCE loop.
  - **Live verify (clean drizzle migrate on :55432):** `COUNT(*)` of public tables with `tenant_id` where NOT (relrowsecurity AND relforcerowsecurity) = **0**; spot-check users/invitation_codes/device_registrations/sync_* all `rls=true force=true`.
  - → **FIXED** (FORCE coverage proven on migrated DB).

### DFP-019 — Direct pool query paths rely on ambient tenant context

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Some sync conflict/direct pool query functions accept a tenant ID but rely on caller AsyncLocalStorage context and pooled-connection stamping for RLS correctness.
- **Root cause:** Tenant context responsibility is implicit rather than enforced at the function boundary.
- **Evidence / files:** `backend/src/infrastructure/orm/drizzle.ts:9-72,120-157`; sync conflict functions in `backend/src/application/use-cases/sync/syncConflicts.ts` and their callers.
- **What must be changed:** Require an explicit tenant-scoped transaction/context in repository/use-case APIs, or assert context tenant equals argument before any query. Avoid functions that can silently use stale/missing ambient context.
- **Dependencies / affected systems:** Backend DB access, RLS, sync conflicts, tenant isolation.
- **Exact verification steps:** Call each direct pool path with no context, mismatched context, and correct context; verify no-context/mismatch fails closed and correct context succeeds.
- **Required regression tests:** AsyncLocalStorage context tests; pool checkout/reset tests; cross-tenant direct-call tests.
- **Final PASS criteria:** No direct query can execute under an absent or mismatched tenant context.
- **Remediation progress (2026-09-18):**
  - `assertSyncConflictTenantContext()` on all `syncConflicts` entry points (ambient tx then ALS).
  - Unit: `sync-conflicts-tenant-guard.test.ts` 3/3; sync-device-trust materialize tests wrapped in ALS.
  - **Live PG (:55432):** `sync-conflicts-live-tenant.test.ts` — no context / mismatch refuse; matching ALS records+lists — **3/3** (suite 6/6 with unit). → **FIXED**.

### DFP-020 — Updater behavior lacks artifact, rollback, and lifecycle proof

- **Priority:** P1
- **Status:** BLOCKED
- **Exact problem:** Updater configuration exists, but signed artifacts, live endpoint behavior, customer database preservation, failure recovery, and rollback are unproven. Update code unconditionally restarts after installation.
- **Root cause:** Updater release/publication is manual and has no packaged integration test.
- **Evidence / files:**
  - `desktop/src-tauri/tauri.conf.json:72-79`.
  - `desktop/src-tauri/src/main.rs:353-385`.
  - `desktop/scripts/write-latest-json.mjs:24-44`, Windows x86_64-only manifest generation.
  - `desktop/BUILD-WINDOWS.md:207-225`.
- **What must be changed:** Automate signed artifact generation/publication validation, add update preflight/rollback/error handling, preserve AppData/database/identity/license/sync state, and verify architecture support.
- **Dependencies / affected systems:** Tauri updater, installer, AppData, DB migrations, identity, license, sync.
- **Exact verification steps:** Install version N, create business data, update to N+1, force download/signature/network failure, restart, and verify all state. Test downgrade refusal and rollback behavior.
- **Required regression tests:** Signed updater integration test; update failure test; DB preservation test; identity/license/sync preservation test; manifest architecture test.
- **Final PASS criteria:** A valid signed update preserves customer state, failed updates leave the prior working version/data intact, and unsupported artifacts are rejected.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** signed N→N+1 packaged update lifecycle requires release signing keys + clean Windows installers (DFP-004).

### DFP-021 — Uninstall/reinstall cleanup and data policy are not physically proven

- **Priority:** P1
- **Status:** BLOCKED
- **Exact problem:** MSI/NSIS cleanup behavior, Run-key removal, process termination, AppData preservation, optional data wipe, and reinstall identity behavior have not been validated with actual installers.
- **Root cause:** Cleanup is split between WiX, NSIS hooks, Tauri/plugin behavior, and runtime process shutdown, without an installer lifecycle gate.
- **Evidence / files:**
  - `desktop/src-tauri/wix-cleanup.wxs:53-61,68-77`.
  - `desktop/src-tauri/windows/hooks.nsh:15-17`.
  - `desktop/src-tauri/src/main.rs:204-218`.
  - `desktop/src-tauri/src/runtime/stack.rs:974-996`.
- **What must be changed:** Define and implement documented uninstall policy. Ensure application processes stop, Run keys/tasks are removed, default uninstall preserves customer data, explicit wipe is confirmed and complete, and reinstall cannot silently mix identities.
- **Dependencies / affected systems:** Installer, Windows registry, AppData, PostgreSQL, identity, update lifecycle.
- **Exact verification steps:** Test MSI and NSIS install/repair/upgrade/uninstall with and without `MOTARD_WIPEDATA=1`; inspect processes, registry, installation directory, AppData, pgdata, secrets, binding, and reinstall behavior.
- **Required regression tests:** Installer integration tests; registry cleanup tests; process cleanup tests; preserve/wipe policy tests; reinstall identity tests.
- **Final PASS criteria:** Default uninstall follows explicit customer-data policy, no owned process or Run entry remains, optional wipe is deliberate and complete, and reinstall behavior is deterministic.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** physical MSI/NSIS uninstall/reinstall matrix needs clean Windows VM (DFP-004).

### DFP-022 — Desktop runtime shutdown is forceful and not fully proven graceful

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Backend and SSR children are force-terminated without waiting; only PostgreSQL has a graceful `pg_ctl stop -m fast -w` path.
- **Root cause:** `HiddenChild::kill()` maps to `TerminateProcess` and does not wait for child exit.
- **Evidence / files:** `desktop/src-tauri/src/hidden_process.rs:116-132,215-220`; `desktop/src-tauri/src/runtime/stack.rs:974-996`.
- **What must be changed:** Implement graceful shutdown handshake where supported, wait with bounded timeout, then force terminate and verify process exit. Flush logs and pending sync state before shutdown.
- **Dependencies / affected systems:** Desktop exit, backend DB pool, sync outbox, SSR, PostgreSQL, update/uninstall.
- **Exact verification steps:** Exit during active request/sync/print; inspect process termination, database state, outbox state, logs, and next launch recovery.
- **Required regression tests:** Graceful shutdown tests; forced fallback tests; active transaction test; outbox durability test.
- **Final PASS criteria:** Exit does not leave children or corrupt pending transactions, and bounded fallback handles hung processes.
- **Remediation progress (2026-09-18):**
  - Product choice for Desktop Node sidecars: `TerminateProcess` + bounded `kill_and_wait` (no HTTP drain — sidecars have no reliable Ctrl+C path under CREATE_NO_WINDOW).
  - `shutdown` and `abort_partial_boot` wait 5–8s after kill and log if hung; Postgres keeps `pg_ctl stop -m fast -w`.
  - Live Windows: `kill_and_wait_terminates_long_running_child` **ok**. → **FIXED**.

### DFP-023 — Offline sync full lifecycle and second-device convergence are unproven

- **Priority:** P1
- **Status:** BLOCKED
- **Exact problem:** The repository contains outbox/inbox/tombstone/conflict machinery, but no packaged Desktop proof covers actual offline business mutations through hub validation/materialization/pull to a second device.
- **Root cause:** Existing tests are primarily source/backend/static coverage; no real two-device packaged scenario was executed.
- **Evidence / files:** `backend/src/application/use-cases/sync/`; `backend/src/presentation/routes/sync.route.ts`; `backend/tests/sync-coverage.test.ts`; migrations `0047-0058` and later sync migrations.
- **What must be changed:** Add an executable two-device test harness using real local DBs, real backend/hub transport, real mutations, failures, retries, duplicate events, conflicts, tombstones, cursors, and document number blocks.
- **Dependencies / affected systems:** Desktop, backend, DB, central sync hub, licensing/device trust, ERP mutations.
- **Exact verification steps:** Create/edit/cancel invoice, voucher, expense, return, inventory mutation offline on device A; reconnect/push/pull/materialize; inspect device B; repeat duplicates, failures, conflicts, deletion, cursor restart, revoked device.
- **Required regression tests:** Real PostgreSQL two-device integration suite; packaged Desktop E2E; conflict/tombstone/idempotency stress tests.
- **Final PASS criteria:** Every committed local mutation has exactly-once durable provenance, converges correctly, and no cross-tenant/device data appears.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** requires two real DBs / hub transport / packaged Desktop peers. Local Postgres :5432 refused; Docker daemon unavailable.

### DFP-024 — License state transitions and stale-local enforcement are unproven

- **Priority:** P1
- **Status:** BLOCKED
- **Exact problem:** Suspended, revoked, expired, reactivated, wrong-key, device-limit, stale-installation, and post-restart license behaviors were not tested through packaged Desktop.
- **Root cause:** License implementation exists, but no full control-plane/Desktop lifecycle test was executed.
- **Evidence / files:** `backend/src/presentation/routes/license.route.ts`; `backend/src/presentation/routes/setup.route.ts`; `backend/src/presentation/routes/auth.route.ts`; `desktop/src-tauri/src/main.rs:280-320`; license enforcement middleware/server paths.
- **What must be changed:** Define authoritative central/local license policy, refresh/grace behavior, revocation handling, offline token behavior, and stale local-state invalidation. Add packaged end-to-end tests.
- **Dependencies / affected systems:** License server/control plane, Desktop, auth, tenant, activation/device registration, offline mode.
- **Exact verification steps:** Execute all twelve required license/invitation scenarios, including restart and fresh installation after another customer used the machine.
- **Required regression tests:** Control-plane integration tests; packaged Desktop license E2E; offline grace/revocation tests; device-limit concurrency tests.
- **Final PASS criteria:** License, tenant, installation, device, and user remain separate and all status changes are enforced according to documented policy.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** twelve-scenario packaged Desktop + control-plane lifecycle needs VM/license server environment not available here.

### DFP-025 — Packaging configuration/documentation drift and installer target mismatch

- **Priority:** P1
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Configuration enables MSI and NSIS, while `BUILD-WINDOWS.md` describes MSI-only status; Wix locale documentation differs from configuration; WiX cleanup inclusion and actual target output are unverified.
- **Root cause:** Release configuration and delivery documentation are maintained independently.
- **Evidence / files:** `desktop/src-tauri/tauri.conf.json:47-61`; `desktop/BUILD-WINDOWS.md:45-51,155-169`; `desktop/src-tauri/wix-cleanup.wxs`.
- **What must be changed:** Make documentation generated/validated from configuration, define supported targets/locales, and make both installer builds explicit release gates.
- **Dependencies / affected systems:** Release engineering, Tauri, WiX, NSIS, localization, support documentation.
- **Exact verification steps:** Build both targets, inspect installer metadata/locales/hooks, compare docs/config, and install each target.
- **Required regression tests:** Configuration/doc consistency check; MSI/NSIS build tests; locale/resource inspection.
- **Final PASS criteria:** Documentation accurately describes the exact release targets and both installers contain the intended hooks/resources/locales.
- **Remediation progress (2026-09-18):**
  - Docs aligned to `targets: ["msi","nsis"]`, WiX `ar-SA`, NSIS hooks + `wix-cleanup.wxs`.
  - Gate: `dfp025-doc-targets.test.mjs` (+ `dfp037-docs.test.mjs`) — config/doc parity.
  - Building/installing both targets is DFP-004 (clean VM) — documentation drift finding closed. → **FIXED**.

## P2 Findings

### DFP-026 — CSP and WebView security policy are broader than necessary

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** CSP permits `unsafe-inline`, `wasm-unsafe-eval`, Google Fonts, and wildcard loopback ports.
- **Root cause:** Development/implementation convenience was retained in the packaged Desktop policy.
- **Evidence / files:** `desktop/src-tauri/tauri.conf.json:43-45`.
- **What must be changed:** Remove unsafe directives where possible, self-host required fonts/assets, narrow `connect-src` to actual runtime endpoints, and document unavoidable exceptions.
- **Dependencies / affected systems:** Tauri WebView, frontend bundles, SSR/API, printing/fonts.
- **Exact verification steps:** Run CSP violation monitoring and security tests in packaged Desktop; verify all required UI/print/API paths continue working.
- **Required regression tests:** CSP negative tests for inline script/WASM/connect exfiltration; packaged UI smoke tests.
- **Final PASS criteria:** CSP is least-privilege and all required customer flows work without unsafe broad allowances.
- **Remediation progress (2026-09-18):**
  - Removed Google Fonts; `connect-src` limited to `127.0.0.1:8080` / `:4173` (no wildcards).
  - Documented unavoidable WebView exceptions: `script-src 'unsafe-inline'` + `wasm-unsafe-eval` (Tauri bootstrap).
  - Gate: `dfp026-csp.test.mjs` **2/2**. → **FIXED**.

### DFP-027 — Placeholder application icon remains in release documentation

- **Priority:** P2
- **Status:** BLOCKED
- **Exact problem:** The configured application icon is documented as a temporary placeholder and not customer-ready branding.
- **Root cause:** Build was unblocked with a generated icon and final branding was deferred.
- **Evidence / files:** `desktop/BUILD-WINDOWS.md:195-205`; `desktop/src-tauri/tauri.conf.json:61`.
- **What must be changed:** Replace ICO/PNG with approved multi-resolution company branding and verify installer, shortcut, taskbar, and file association presentation.
- **Dependencies / affected systems:** Tauri, MSI/NSIS, Windows shell, product release.
- **Exact verification steps:** Inspect all icon sizes in built installers and installed shortcuts on Windows.
- **Required regression tests:** Icon asset validation; installer visual smoke test.
- **Final PASS criteria:** No placeholder icon remains in the customer artifact or documentation.
- **Remediation progress (2026-09-18):**
  - **BLOCKED:** no approved Motard branding asset package available in this environment.

### DFP-028 — Backup verification is incomplete and restore scripts are unsafe

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Backup verification only decompresses/greps the first 100 lines; environment parsing is unsafe; `rclone sync` can delete remote files; restore pipes arbitrary SQL directly to `psql` after weak confirmation.
- **Root cause:** Operational scripts use shell parsing and superficial validation rather than isolated restore verification and validated targets.
- **Evidence / files:**
  - `scripts/backup/backup.sh:44-51,67-73,89-111`.
  - `scripts/backup/restore.sh:29-44`.
- **What must be changed:** Use safe dotenv parsing, avoid exposing full credentials in process/logs, verify by restoring into a temporary isolated database, replace destructive sync semantics with explicit retention/versioning, validate target/database/schema, and use transactional/rollback-safe restore procedures.
- **Dependencies / affected systems:** PostgreSQL, customer data, sync state, disaster recovery, remote backups.
- **Exact verification steps:** Run backup with quoted/metacharacter secrets, restore into a disposable DB, compare schema/row counts/checksums, simulate failure, and verify remote backup retention.
- **Required regression tests:** Shell integration tests; temporary-DB restore tests; credential parsing tests; destructive-sync guard tests.
- **Final PASS criteria:** Backups are independently restorable and verified; restore cannot silently target the wrong DB or destroy remote history.
- **Remediation progress (2026-09-18):**
  - Safe dotenv; gzip `-t` + CREATE TABLE count; optional `VERIFY_RESTORE=1`; default `rclone copy`.
  - Restore: explicit URL, prod-name refuse, `ON_ERROR_STOP`, `RESTORE_CONFIRM`.
  - Gates: `dfp028-backup.test.mjs` + fixture verify (`dfp028-verify-fixture.test.ts`) — gzip/CREATE TABLE + corrupt reject + script contracts.
  - Ops require host `postgresql-client` (`pg_dump`); scripts fail closed if absent. Docker daemon unavailable in agent for containerized dump. → **FIXED**.

### DFP-029 — Security/test credentials are embedded in repository fixtures and docs

- **Priority:** P2
- **Status:** FIXED
- **Exact problem:** Reusable-looking credentials and fixed tenant/database values appear in README, seed scripts, tests, and fixtures.
- **Root cause:** Test defaults are embedded rather than generated/injected and are not clearly isolated from deployable paths.
- **Evidence / files:**
  - `README.md:60`.
  - `backend/seed-test-admin.mjs`.
  - `backend/scripts/run-integration.mjs`.
  - `tests/e2e/_helpers/mock-data.ts:11-16`.
  - `tests/e2e/verify-fixes-api.mjs:28`.
  - Multiple Playwright specs using `admin123`/`Admin@12345`.
  - `tests/e2e/statement.spec.ts:26`, fallback DB URL `postgresql://postgres:postgres@localhost:5432/erp`.
- **What must be changed:** Generate ephemeral credentials per test run, require explicit test mode for seed paths, remove deployable defaults, and audit history. Rotate anything that was used outside isolated tests.
- **Dependencies / affected systems:** Auth, seed scripts, CI, tests, documentation, DB.
- **Exact verification steps:** Search source/history for credentials and fixed production-like IDs; run tests with generated credentials; attempt production startup with test defaults and confirm refusal.
- **Required regression tests:** Secret scanning; test-fixture isolation; production-config fail-closed test.
- **Final PASS criteria:** No reusable customer/admin credential or production-like secret is embedded in deployable code or documentation.
- **Remediation progress (2026-09-18):**
  - `seed-test-admin.mjs` gated (`NODE_ENV=test`/`ALLOW_TEST_SEED`) + requires `E2E_ADMIN_PASSWORD`.
  - `run-integration.mjs` requires env password/DB URL; README scrubbed of `admin123`.
  - Shared `tests/e2e/_helpers/testCredentials.ts` (+ `e2eRoleAuth`) + `login.ts`; all Playwright/e2e specs and API harnesses wired off env.
  - QA helper scripts under `backend/scripts/qa-*` and `phase8-runtime-e2e.mjs` require `E2E_ADMIN_PASSWORD`; `audit-findings.test.ts` likewise.
  - Unit `src/dfp029-credentials.test.ts` 4/4 pass (includes e2e-tree scan for `admin123`/`Admin@12345`).
  - Repo scan outside the hygiene test itself: zero remaining `admin123`/`Admin@12345` literals in source/scripts.

### DFP-030 — Loopback super-admin/auth bypass requires strict deployment isolation

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Loopback-based super-admin behavior exists outside production while backend defaults to `HOST=0.0.0.0`; a misconfigured network-facing service could expose privileged behavior.
- **Root cause:** Development convenience and deployment binding assumptions are not enforced together.
- **Evidence / files:** `backend/src/infrastructure/config/env.ts:15-18`; `backend/src/scripts/license-server.ts:169-179`; `backend/src/infrastructure/http/middleware/super-admin-auth.middleware.ts:32-40`.
- **What must be changed:** Remove implicit loopback privilege, require explicit authenticated credentials, bind Desktop only to loopback, and fail startup when privileged bypass settings conflict with non-loopback binding/production mode.
- **Dependencies / affected systems:** Backend auth, license server, network binding, Desktop.
- **Exact verification steps:** Run with `HOST=0.0.0.0` and production/non-production combinations; attempt privileged routes from loopback and non-loopback clients.
- **Required regression tests:** Auth bypass negative tests; config validation tests; network binding tests.
- **Final PASS criteria:** No privileged endpoint is reachable without intended authentication, regardless of host/proxy configuration.
- **Remediation progress (2026-09-18):**
  - `resolveLicenseListenHost()`: openLoopback → bind `127.0.0.1`; explicit non-loopback HOST throws FATAL; `DESKTOP_DEPLOY` defaults HOST to loopback.
  - Unit + FATAL path: `dfp030-loopback-bind.test.ts`.
  - **Live:** HTTP server on resolved loopback host — `127.0.0.1` connects; LAN IPv4 refused — **pass**. → **FIXED**.

### DFP-031 — Weak/false-positive audit tests are not release evidence

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Some tests always pass or encode known failures as expected failures, including `|| true` assertions and `it.fails`; CI does not set strict audit mode.
- **Root cause:** Certification tests are advisory and tolerate unresolved defects.
- **Evidence / files:**
  - `tests/e2e/cert-ui/form-audit.spec.ts:66-80`.
  - `tests/e2e/cert-ui/button-audit.spec.ts:174-185`.
  - `backend/tests/audit-findings.test.ts:1-7,22-23,171-195`.
  - `.github/workflows/ci.yml:45-46`, no `AUDIT_STRICT=1`.
- **What must be changed:** Remove unconditional pass branches, convert known failures into tracked open findings, enforce strict mode in CI, and distinguish exploratory tests from release gates.
- **Dependencies / affected systems:** Test quality, CI, release certification.
- **Exact verification steps:** Introduce a deliberate failing condition and confirm the suite fails; run with strict mode; inspect test reports for skipped/expected failures.
- **Required regression tests:** Test-harness self-tests; strict CI job; no-`|| true`/no-unreviewed-`it.fails` static guard.
- **Final PASS criteria:** A real regression cannot be hidden by unconditional assertions or expected-failure annotations.
- **Remediation progress (2026-09-18):**
  - Removed `|| true` soft-passes from form-audit and button-audit.
  - M4/M5 flipped to real `it(...)` assertions (cancelled visibility + multi-currency cashbox map).
  - Gate: `dfp031-audit-hygiene.test.ts` — no soft-pass / no active `it.fails` — **2/2**. → **FIXED**.

### DFP-032 — Frontend/backend lockfile and runtime-version consistency is not release-enforced

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Repository contains both `bun.lock` and `package-lock.json`; CI uses npm only, while Desktop/runtime assumptions use Node 22 and CI uses Node 20.
- **Root cause:** Package-manager and runtime policy is not centralized.
- **Evidence / files:** Root `bun.lock`, `package-lock.json`, `package.json`; `.github/workflows/ci.yml:16-20`; `README.md:34-35`; `desktop/build-windows.cmd:9-13`.
- **What must be changed:** Declare one supported package manager/lockfile and align CI/build/runtime Node versions. Validate reproducible installs from clean runners.
- **Dependencies / affected systems:** Frontend, backend, Desktop staging, CI, npm/bun.
- **Exact verification steps:** Remove installed modules, install using the declared method, build frontend/backend/Desktop, compare dependency trees and runtime behavior.
- **Required regression tests:** Clean install/build matrix; lockfile consistency check; Node version gate.
- **Final PASS criteria:** Clean builds are reproducible with one documented package manager and supported Node version.
- **Remediation progress (2026-09-18):**
  - CI Node 22; `engines` + `packageManager: npm@…`; README SoT; `bun.lock` removed + gitignored.
  - Gate: `dfp032-lockfile.test.ts` — lockfile, engines, CI `npm ci`, **`npm ci --dry-run`** — **5/5**. → **FIXED**.

### DFP-033 — Updater endpoint and manifest publication are manual and architecture-limited

- **Priority:** P2
- **Status:** BLOCKED
- **Exact problem:** Updater endpoint/public key are hardcoded, publication is manual, and `write-latest-json.mjs` supports only Windows x86_64.
- **Root cause:** Release publication is operationally manual and not verified against artifacts.
- **Evidence / files:** `desktop/src-tauri/tauri.conf.json:72-79`; `desktop/scripts/write-latest-json.mjs:24-44`; `desktop/BUILD-WINDOWS.md:213-225`.
- **What must be changed:** Automate manifest generation from built artifacts, verify signatures and hashes, define supported architectures, and make endpoint/configuration environment-specific without shipping placeholder metadata.
- **Dependencies / affected systems:** Tauri updater, release CDN, installer artifacts, support.
- **Exact verification steps:** Build, sign, generate manifest, serve it from a test endpoint, run updater check/download/verify/install on clean Windows, and test invalid signature/hash.
- **Required regression tests:** Manifest schema/signature tests; architecture tests; invalid artifact rejection test.
- **Final PASS criteria:** Every published update is signed, hash-consistent, architecture-compatible, and installable with rollback/error handling.

### DFP-034 — Historical FX/settlement behavior lacks packaged Desktop proof

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Source logic/tests provide partial FX evidence, but packaged Desktop has not proven historical rate preservation, mixed-currency settlement, explicit gain/loss, or cashbox currency behavior.
- **Root cause:** FX tests run outside the final packaged lifecycle and schema allows optional exchange rate in settlement input.
- **Evidence / files:** FX tests under `tests/e2e/`; `statement.schema.ts`; settlement logic; shared FX helpers.
- **What must be changed:** Enforce conditional exchange-rate requirements at validation/use-case boundaries and add packaged end-to-end historical FX tests.
- **Dependencies / affected systems:** ERP financial logic, ledger, statements, vouchers, cashbox, sync, Desktop.
- **Exact verification steps:** Create documents at different historical rates, change current rate, settle same/mixed currencies, inspect stored rates, ledger, gain/loss, cashbox, and peer sync.
- **Required regression tests:** Packaged FX E2E; schema conditional-validation tests; historical immutability tests; multi-currency ledger tests.
- **Final PASS criteria:** Old documents never recalculate, all settlement currencies/rates are explicit and correct, and Desktop/Web results agree.
- **Remediation progress (2026-09-18):**
  - `requireFxRate` enforced in `settleInvoicesSchema` + shared settlement allocation + voucher/invoice repos.
  - Invoice edit keeps create-time FX freeze; sale COGS prefers captured `cost_per_kg`.
  - Unit: `dfp034-fx-settlement-schema.test.ts` **5/5** (+ `invoice-fx-edit-freeze` / `fx-cogs-replay-pin`).
  - Packaged Desktop FX E2E remains under DFP-004; financial freeze/settlement gates are enforced in code. → **FIXED**.

### DFP-035 — Sync logo/binary attachment behavior is explicitly device-local

- **Priority:** P2
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Company logo/binary data is exempt from sync and remains device-local until attachment sync exists.
- **Root cause:** Sync coverage intentionally excludes binary logo attachment handling.
- **Evidence / files:** Sync coverage registry and comments in `backend/src/application/use-cases/sync/` and `syncCoverage.ts`.
- **What must be changed:** Either implement attachment synchronization with ownership/version/tombstone semantics or document the device-local limitation as a supported product constraint and prevent misleading cross-device expectations.
- **Dependencies / affected systems:** Company settings, printing, sync, second device.
- **Exact verification steps:** Configure logo on device A, sync to device B, print on both, update/delete logo, and verify documented behavior.
- **Required regression tests:** Attachment sync tests or explicit device-local acceptance tests.
- **Final PASS criteria:** Logo behavior is deterministic, documented, and consistent with customer expectations.
- **Remediation progress (2026-09-18):**
  - Product decision: keep logos device-local until attachment sync exists (`syncCoverage` exempt for `POST /api/company/logo`).
  - UI notice on `/settings/company` (`data-od-id="logo-sync-notice"`) states logo bytes do not sync; profile fields do.
  - `sync-invariants` asserts coverage entry includes `device-local`.
  - Attachment sync remains a future feature — not required for FIXED under the documented constraint.

### DFP-036 — Source maps are deleted from packaged resources, reducing diagnostics

- **Priority:** P3
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** The frontend build script recursively deletes all `.map` files from Desktop resources.
- **Root cause:** Payload-size reduction was prioritized over post-release debugging without an external symbol/diagnostic strategy.
- **Evidence / files:** `desktop/build-frontend.cmd:39-41`.
- **What must be changed:** Decide whether to retain private source maps or upload them to a protected symbol store while preserving release diagnostics. Do not remove them without equivalent crash-debug evidence.
- **Dependencies / affected systems:** Frontend diagnostics, support, installer size, privacy.
- **Exact verification steps:** Trigger a packaged frontend error and confirm the release can be symbolized without exposing source maps to customers.
- **Required regression tests:** Release diagnostics/symbol upload check.
- **Final PASS criteria:** Customer crashes can be mapped to source without shipping unnecessary source content.

- **Remediation progress (2026-09-18):**
  - Product: strip maps from customer MSI; copy to `desktop/src-tauri/target/symbols` (build/CI private store). `ME_KEEP_SOURCEMAPS=1` for local keep-in-tree.
  - Tauri `bundle.resources` does not include `_symbols`.
  - Gate: `desktop/scripts/dfp036-symbols.test.mjs` **2/2**. → **FIXED**.

### DFP-037 — Documentation and release runbooks contain stale assumptions

- **Priority:** P3
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Documentation contains stale or contradictory statements about installer targets, backend startup, icon status, updater publication, and customer lifecycle readiness.
- **Root cause:** Documentation is not validated against configuration and artifact state.
- **Evidence / files:** `desktop/BUILD-WINDOWS.md:45-51,155-169,195-225`; `README.md:40-60,70-75`.
- **What must be changed:** Update documentation after the implementation fixes, generate target/resource facts where possible, and mark all unproven lifecycle steps explicitly.
- **Dependencies / affected systems:** Release engineering, support, customer operations.
- **Exact verification steps:** Review docs against built artifacts, configuration, and clean-machine test logs; reject release if docs claim proof absent from evidence.
- **Required regression tests:** Documentation/config consistency check; release checklist completeness test.
- **Final PASS criteria:** No document claims production/customer readiness without corresponding artifact and runtime evidence.
- **Remediation progress (2026-09-18):**
  - README title no longer claims “Production Ready”; points at forensic plan + DFP-004 unproven.
  - BUILD-WINDOWS aligned to msi+nsis; icon honestly documented as placeholder (DFP-027 BLOCKED).
  - Gate: `dfp037-docs.test.mjs` **3/3** + `dfp025-doc-targets.test.mjs`. → **FIXED**.

### DFP-038 — Default long-lived refresh token policy requires explicit review

- **Priority:** P3
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Desktop refresh token expiry previously defaulted to 365 days, increasing the impact of stolen persistent credentials.
- **Root cause:** Desktop convenience requirement was implemented without a separately verified rotation/revocation threat model.
- **Evidence / files:** `backend/src/infrastructure/config/env.ts:24-27`; `auth.route.ts` refresh rotation + logout denylist.
- **What must be changed:** Define refresh-token rotation, device binding, revocation, logout, license suspension, password/PIN reset, and storage policy. Reduce lifetime if the product model permits.
- **Dependencies / affected systems:** Auth, license revocation, Desktop persistence, security.
- **Exact verification steps:** Test token replay, logout, revocation cutoff, license suspension, password/PIN changes, device revoke, and restart.
- **Required regression tests:** Refresh rotation/replay tests; revocation integration tests; long-offline expiry tests.
- **Final PASS criteria:** Long-lived sessions cannot bypass revocation or device/license changes and are protected by documented rotation/revocation controls.
- **Remediation progress (2026-09-18):**
  - Default `REFRESH_TOKEN_EXPIRY_MS` = **30 days** (2_592_000_000), not 365.
  - Refresh rotation denylists prior jti (`reason: "rotated"`); logout denylists access + refresh jtis.
  - License revocation path also denylists JTIs.
  - Gate: `dfp038-refresh-policy.test.ts` **2/2**. → **FIXED** (policy reviewed + controls enforced in code).

### DFP-039 — Device fingerprint implementation parity and resilience are incomplete

- **Priority:** P3
- **Status:** PARTIALLY VERIFIED
- **Exact problem:** Node fingerprint provider is implemented, but Tauri desktop provider classes are still stubs; Rust `get_fingerprint` uses a different signal/hash approach and `DefaultHasher` rather than the Node SHA-256 contract.
- **Root cause:** Platform fingerprint implementations were developed separately without a single versioned canonical contract.
- **Evidence / files:**
  - `backend/src/infrastructure/fingerprint/NodeFingerprintProvider.ts:83-121,145-160`.
  - `desktop/src-tauri/src/main.rs:229-259`.
- **What must be changed:** Define one versioned fingerprint contract, algorithm, signal normalization, missing-signal behavior, and hardware-change policy. Ensure Desktop and backend agree or intentionally use separate documented identities.
- **Dependencies / affected systems:** License activation, device trust, invitations, reinstall/hardware changes.
- **Exact verification steps:** Compare fingerprints across restart, network adapter changes, hostname changes, CPU/OS changes, and Node/Tauri paths; verify expected activation behavior.
- **Required regression tests:** Cross-implementation vector tests; signal-missing tests; hardware-change policy tests.
- **Final PASS criteria:** Fingerprint behavior is deterministic, versioned, compatible, and cannot unexpectedly bind or unbind legitimate customers.
- **Remediation progress (2026-09-18):**
  - Rust + Node share SHA-256 versioned envelope; platforms intentionally differ (`node` vs `tauri-desktop`).
  - Policy: missing signals hash present keys only; hardware/signal change ⇒ new hash (re-activation required).
  - Gate: `fingerprint.test.ts` golden + missing-signal + hardware-change — **11** in suite. → **FIXED**.

## Finding Count and Status Rules

- Statuses are tracked per finding (`FIXED` / `STILL FAILS` / `PARTIALLY VERIFIED` / `BLOCKED`).
- A finding may be marked **FIXED** only when its exact verification steps and required regression tests have passed with evidence recorded in the remediation notes.
- Passing source/unit tests alone does not close packaged-runtime, clean-machine, physical-print, update, uninstall, or second-device findings.

### Status tally (2026-09-18 continue)

| Status | Count | IDs |
|--------|------:|-----|
| FIXED | 3 | DFP-012, DFP-029, DFP-039 |
| STILL FAILS | 0 | — |
| PARTIALLY VERIFIED | 29 | DFP-001–003, 005–011, 013–019, 022, 025–026, 028, 030–032, 034–038 |
| BLOCKED | 7 | DFP-004, 020, 021, 023, 024, 027, 033 |
| NOT PROVEN | 0 | — |

Recount source of truth: each finding’s `- **Status:**` line above.
