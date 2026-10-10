# Hermes Handoff — 2026-10-08

Resume prompt: "Read docs/HERMES-HANDOFF-2026-10-08.md and continue exactly from where you stopped."
Master plan for this work: `docs/FINAL-CLEAN-RELEASE-REMEDIATION-PLAN.md` (untracked file — see §8).

## 1. Exact current task and final goal
Take over the full Motard Fabrics Group ERP desktop remediation and release: fix the P0 factory-reset dead-end, clean all local/Render test data and repo artifacts, verify the upgrade-vs-uninstall path, run all test suites, build the 2.0.4 Windows x64 installer, verify clean-install + upgrade-over-2.0.3, commit and push to `clean-desktop-release`, return the installer path + SHA-256. The user issued STOP mid-flow (after the 2.0.4 installer finished building, before installer verification tests) and ordered this handoff instead.

## 2. Exact point where you started
Branch `clean-desktop-release` @ `5cc228a1` ("Bump desktop version to 2.0.3 and build Windows x64 installer"), clean working tree, desktop 2.0.3. Remediation plan document already written in a prior turn of this session.

## 3. Everything investigated (evidence-based, this session)
- `docs/FINAL-CLEAN-RELEASE-REMEDIATION-PLAN.md` — full 7-problem investigation (factory reset root cause, local test data, Render hub wipe procedure, repo artifact classification, clean-build definition, upgrade-vs-uninstall analysis, 7 additional blockers F1–F7).
- Factory reset root cause (Problem 1): `move_data_aside` in `desktop/src-tauri/src/runtime/stack.rs` left `pgdata/` (retired PostgreSQL cluster) and the `data-integrity.json` manifest behind (manifest rename was best-effort `let _`), so the next boot's `prior_data_evidence` (`desktop/src-tauri/src/db_meta.rs:308-322`) escalated a successful reset to DATA_MISSING — the dead "Restore Session" screen.
- SYNC-06/P6 conflict: commit `286506f8` introduced a wire-read of `payload.actorUserId` inside `materializeRollAdjust` (`backend/src/application/use-cases/sync/syncMaterialize.ts`), violating the source-scan security invariant in `backend/tests/sync-invariants.test.ts` ("replay identity ignores every wire-supplied actor field") — the backend SQLite suite was 1 failed / 793 passed before the fix.
- Verified installed desktop data root `%LOCALAPPDATA%\motard-erp` held only seed test data (`data-integrity.json`: tenants 1, users 1, parties 0, invoices 0, rolls 0 — no real/customer data) before deleting it.
- Confirmed no Render DB credentials exist anywhere in the repo (`backend/.env` DATABASE_URL points to localhost; hub URL `me-sh6t.onrender.com` appears only in docs; hub API was asleep, curl timeout).
- Confirmed only untracked items in the working tree were my two docs (earlier reported untracked source dirs did not reproduce).

## 4. Everything changed (code/config)
1. `desktop/src-tauri/src/runtime/stack.rs` — `move_data_aside` now: (a) renames `pgdata/` into the reset archive (kept, never deleted), (b) makes the `data-integrity.json` rename mandatory (propagates errors). Added regression test `reset_on_a_root_with_leftover_pgdata_and_manifest_boots_fresh` asserting the next boot is FRESH with `pgdata` + live manifest present.
2. `backend/src/application/use-cases/sync/syncMaterialize.ts` — `SyncMaterializeMeta` gained `originActorName?: string | null`; `materializeRollAdjust` now takes `meta`, no longer reads `payload.actorUserId/actorUserName`; audit origin actor is `{ id: null, name: meta?.originActorName }` (authority stays the authenticated receiver).
3. `backend/src/application/use-cases/sync/syncUseCases.ts` — both `materializeSyncUnit` call sites (pull path `materializeOne`, hub push path `tryMaterializeAcceptedUnit`) pass display-only `originActorName` derived from the payload's `actorUserName` (trimmed, ≤255 chars).
4. `backend/tests/sqlite/sync-master-edit.test.ts` — `apply` helper passes `originActorName` via meta; the roll-adjust audit expectation changed to `actor_id = ctx.userId` (receiver) with the origin device surviving as the display name, per SYNC-06.
5. `src/lib/sync-device.ts` — new `clearSyncDeviceState()` removing `erp.sync.deviceId`.
6. `src/components/auth/UserPickerPage.tsx` — the typed-phrase factory reset now clears tokens + `clearLicense()` + `clearRememberedEmail()` + `clearSyncDeviceState()` before `applyFactoryResetNow()`, so no stale session/license/sync marker traps the fresh boot.
7. Version bump to **2.0.4**: `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, `desktop/package.json`, root `package.json` (root was 2.0.2 — fixes blocker F5 version drift).

## 5. Files created
- `docs/FINAL-CLEAN-RELEASE-REMEDIATION-PLAN.md` (untracked, not yet committed)
- `backend/scripts/wipe-hub-tenant.mjs` (untracked, not yet committed) — tenant-scoped hub wipe: dry-run counts by default, `--execute` wipes business + sync tables per tenant inside one transaction (RLS tenant context via `set_config`, `DROP/CREATE TRIGGER trg_ledger_entries_append_only` inside the tx, sequence resets, keeps tenants/users/system_admins/migrations/RLS; post-verify counts). NEVER run against a real/customer hub without confirmation.
- `docs/HERMES-HANDOFF-2026-10-08.md` (this file)

## 6. Files modified
`.gitignore` (+`scripts/parity/out/`), `desktop/src-tauri/src/runtime/stack.rs`, `backend/src/application/use-cases/sync/syncMaterialize.ts`, `backend/src/application/use-cases/sync/syncUseCases.ts`, `backend/tests/sqlite/sync-master-edit.test.ts`, `src/lib/sync-device.ts`, `src/components/auth/UserPickerPage.tsx`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, `desktop/package.json`, `package.json` — all in `git status` as modified, none committed.

## 7. Files deleted
From git tracking (`git rm`, staged): `bunfig.toml`, `skills-lock.json`, `my-project/` (20 speckit files), `docs/durability-proof/` (41 ndjson dump files, ~4.8 MB; summary doc `docs/DURABILITY-PROOF-RESULTS.md` kept), `scripts/parity/out/` (889 files, ~12 MB; gitignored now, regenerated by parity runs).
From disk (all gitignored/untracked, verified disposable first): `backup/` (84 MB PG-era dumps), `logs/`, `test-results/`, `dist/` (root), `.agents/`, `.claude/`, `desktop/logs/`, `backend/sync-test-*.log`, `docs/TASK_PLAN_OPENING_BALANCE_AND_PRINT.md` (superseded one-off AI plan).
Local machine test state (all verified test-only first): `%LOCALAPPDATA%\motard-erp` (143 MB incl. retired `pgdata/`), `%LOCALAPPDATA%\motard-erp-dev`, `%LOCALAPPDATA%\com.motardfabrics.erp` (WebView2 profile), registry `HKCU\Software\MotardFabricsErp` (InstallInstanceId).
Local PostgreSQL 17 was started for the PG-backed backend suites, then **stopped** (`pg_ctl stop -m fast`, confirmed "server stopped") per the user's directive not to depend on local PostgreSQL.

## 8. Commits created/pushed
NONE. Nothing has been committed or pushed this session. Branch: `clean-desktop-release`. HEAD: `5cc228a1` "Bump desktop version to 2.0.3 and build Windows x64 installer". Working tree: ~11 modified files + staged deletions + 3 untracked files (two docs + wipe script). The 2.0.4 release commit is NOT yet made.

## 9. Current Git branch
`clean-desktop-release`

## 10. Current HEAD commit
`5cc228a1` — "Bump desktop version to 2.0.3 and build Windows x64 installer"

## 11. Current desktop version
**2.0.4** (all four manifests: root package.json, desktop/package.json, tauri.conf.json, Cargo.toml). Previously released: 2.0.3.

## 12. Current Render/Hub state
UNTOUCHED. Hub service `ME` (`me-sh6t.onrender.com`, free tier — sleeps; API curl timed out) still runs the pre-2.0.4 backend; test business data on hub DB `motard-sync-test1` NOT wiped. `backend/scripts/wipe-hub-tenant.mjs` is ready but was never executed (needs the hub DATABASE_URL). No migration/redeploy performed.

## 13. Current local database/test-data state
- Local desktop test data: DELETED (see §7). Machine is in a clean state for first-use installer verification.
- The 2.0.3 installer still exists at `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.3_x64-setup.exe` — NEEDED for the upgrade-over-old-version test; do not delete.
- Local PostgreSQL 17: STOPPED, and per user directive must stay stopped (SQLite architecture only).
- The 2.0.4 installer exists at `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.4_x64-setup.exe` (build exit 0).

## 14. Tests already run and exact results
- Frontend `npx vitest run`: **304/304 passed** (69 files) — after the reset/localStorage changes.
- Backend SQLite suite (`DB_ENGINE=sqlite npx vitest run`, in `backend/`): **794 passed / 0 failed / 37 skipped** (831 total) — after the SYNC-06 fix (was 793/1 failed before).
- Targeted re-run of the two touched suites (`tests/sync-invariants.test.ts` + `tests/sqlite/sync-master-edit.test.ts`): 91/91 passed.
- Rust `cargo test` in `desktop/src-tauri`: **102 passed / 0 failed** (95 lib incl. the new factory-reset regression test + 7 main.rs).
- Desktop script tests `node --test scripts/*.test.mjs`: **27/27 passed**.
- `npm run typecheck` (frontend) and `cd backend && npm run typecheck`: 0 errors.
- PG-backed backend suites: NOT run (user directive: no local PostgreSQL dependency; the 37 skipped sqlite-suite tests require PG by design).

## 15. Builds already completed and exact results
- `npm run tauri:build` in `desktop/` (2.0.4, x64 NSIS): **exit 0**. Freshness gate all OK (server bundle newer than every backend/frontend source; 238-file manifest; no unreferenced chunks). Output: `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.4_x64-setup.exe`. Rust release compile 4m44s, 3 dead-code warnings only (health.rs `wait_tcp`/`http_get_ok`, pipe.rs `is_listening` — pre-existing, non-blocking).

## 16. Confirmed fixed
- Factory reset no longer leaves `pgdata/` or an unmoveable manifest behind → next boot evaluates FRESH (regression test proves the reported dead-end scenario).
- Factory reset from the login screen wipes WebView-local session/license/email/sync markers, so no stale "restore session" trap.
- SYNC-06/P6 trust boundary restored: replay never reads actor identity from the wire; origin device survives as display-only audit name.
- Version drift F5 resolved (root package.json 2.0.2 → 2.0.4).
- Repo/test-artifact bloat removed (~100 MB disk, ~17 MB from git tracking); `scripts/parity/out/` gitignored.
- Local machine cleaned of all test business data — ready for genuine first-use installer verification.

## 17. NOT fixed yet (open items from the remediation plan)
- F1: desktop auto-updater can never fire (`tauri.conf.json` `createUpdaterArtifacts: false`, no signed artifacts, no `latest.json` publisher wired) — HIGH, needs updater key + publishing decision.
- F2: durability scenarios recorded NOT_RUN in `docs/DURABILITY-PROOF-RESULTS.md` — need re-run against the 2.0.4 binary.
- F3: dye purge sync-exempt (hub divergence) — HIGH.
- F4: desktop SQLite money columns INTEGER vs fractional USD — needs owner decision/verification.
- F6: second-device install-tenant resolution TODO in `auth.route.ts`.
- F7: DR runbook gaps (restore-into-mismatched-version etc. unverified).
- Upgrade gaps from plan §6.2/6.3 (same-version reinstall asks PRIOR_DATA_FOUND; manual setup.exe has no preinstall app/lock guard) — NOT implemented (plan only).
- Installer verification tests (clean install + upgrade-over-2.0.3) — NOT yet executed (see §22/23).
- Hub data wipe + hub redeploy with 2.0.4 backend — NOT started.

## 18. What is currently in progress
Nothing running. The 2.0.4 installer build had just completed (exit 0); the next step (installer verification tests) had NOT started when STOP arrived.

## 19. What command/process was running when you stopped
`npm run tauri:build` (background session `proc_066a5205a1c6`) — had exited 0 with the NSIS bundle produced. No process left running; local PostgreSQL was already stopped earlier per user directive.

## 20. Exact blocker requiring user input
Render Hub wipe + redeploy needs the hub PostgreSQL connection string (exists only in the user's Render dashboard). The user answered in-session: "I'll paste the Render DATABASE_URL in my next message" — it was NEVER provided before STOP. Ask for it again on resume (secure/masked channel; never store the value in any file).

## 21. Render DATABASE_URL requirement (no secret value)
`backend/scripts/wipe-hub-tenant.mjs` connects with `DATABASE_URL` to run its dry-run/`--execute` wipe against the Render hub Postgres (`motard-sync-test1`), and any hub redeploy/migration of the 2.0.4 backend needs the same connection string. The repo's `backend/.env` DATABASE_URL points to localhost and must NOT be used for the hub. Reason it was requested: the wipe cannot run without it and there is no API endpoint to wipe tenant data. Never write the secret into this file, any repo file, or chat.

## 22. Exact next action
Run the installer verification tests for the already-built 2.0.4 installer:
1. **Clean-install test (A):** run `Motard Fabrics Group ERP_2.0.4_x64-setup.exe /S`, launch the app, verify `%LOCALAPPDATA%\motard-erp` boots FRESH (db-meta.json created, no pgdata, boot log STARTUP_STATE=FRESH, setup wizard state), close cleanly.
2. **Upgrade test (B):** install 2.0.3 first (`..._2.0.3_x64-setup.exe /S`), launch so it creates its data root, record the SHA-256 of `%LOCALAPPDATA%\motard-erp\data\motard.db` + AppData tree snapshot, quit, then install 2.0.4 over it and verify: no uninstall-first prompt, data root untouched (hash unchanged), boot evaluates REUSE (version-newer adopt: 2.0.4 > 2.0.3 in `motard_meta.app_version_last_opened`), secrets.dat/device-binding/pairing preserved.
3. Compute SHA-256 of the 2.0.4 installer.

## 23. Exact sequence of remaining actions until final clean desktop release
1. §22 installer verification (clean install A, upgrade B, SHA-256).
2. Commit everything (fixes + version bump + docs + wipe script + deletions) on `clean-desktop-release`; push to origin.
3. Ask user for Render DATABASE_URL (masked/secure; §20).
4. Run `backend/scripts/wipe-hub-tenant.mjs` (dry-run first, review counts, then `--execute`) against the hub.
5. Optionally redeploy the hub backend with the 2.0.4 sync fixes (user decision — backend/src changes should reach Render).
6. Report the final short result per the original task format (Version / Installer path / Commit / SHA-256 / Tests / clean-install / upgrade / factory-reset / hub / blockers). Say "FINAL DESKTOP RELEASE READY" only if everything verified.
7. Remaining plan items F1–F7 and §6.2/6.3 upgrade gaps stay documented as follow-ups unless the user orders them.

## 24. Dangerous actions that must NOT be repeated
- Do NOT run `backend/scripts/wipe-hub-tenant.mjs --execute` against any hub without explicit user confirmation of the target tenant (it permanently deletes business + sync data; the Render DB may hold the only copy of real company data if tenants were reused).
- Do NOT delete `%LOCALAPPDATA%\motard-erp` again before installer test A captures first-use state — it is already clean; recreating test data happens by launching the installed app.
- Do NOT delete `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.3_x64-setup.exe` — required for upgrade test B.
- Do NOT start local PostgreSQL again (user directive; SQLite architecture).
- Do NOT trigger a factory reset inside the installed app while verification is in flight (it archives `data/` — would falsify the upgrade hash comparison).
- Avoid `git clean -fdx`: it would destroy `desktop/src-tauri/resources/` (gitignored build output) and the local installers.

## 25. Assumptions that must be re-verified after resuming
- The working tree still contains all §6 modifications and 3 untracked files (verify with `git status`; nothing was committed).
- The 2.0.4 installer at the §15 path exists, is current (post-fix), and launches (build succeeded but the binary was never executed).
- The upgrade REUSE-adopt rule (version-newer over `app_version_last_opened`) covers 2.0.3→2.0.4 — proven in unit tests (`db_meta.rs::a_newer_version_over_the_installed_copy_is_an_update_not_a_new_installation`) but not yet on real installers.
- `secrets.dat`/`device-binding.dat` survive NSIS over-install (by hooks.nsh design, never exercised end-to-end this session).
- The hub is still asleep/free-tier and still runs pre-2.0.4 backend code; its DB still holds test data (nothing was wiped).
- Test results in §14 were captured before the final installer build; no source changed after them, so results should hold — re-run suites if anything changed after resume.
