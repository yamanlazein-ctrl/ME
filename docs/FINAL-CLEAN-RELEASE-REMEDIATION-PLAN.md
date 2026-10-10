# Final Clean-Release Remediation Plan

- **Date:** 2026-10-08
- **Branch:** `clean-desktop-release` @ `5cc228a1` — "Bump desktop version to 2.0.3 and build Windows x64 installer"
- **Desktop:** 2.0.3 (Tauri v2 + bundled Node/Express backend + embedded SQLite; embedded PostgreSQL retired)
- **Mode:** investigation and plan only. **No code was changed.** Every claim below carries file:line or git evidence.

---

## Executive Summary

| # | Problem | Verdict | Severity |
|---|---|---|---|
| 1 | Factory reset reopens into a dead "Restore Session" screen | **Confirmed, root cause found in code** | **P0** |
| 2 | Test/business data in the current desktop data roots | **Confirmed (runtime + repo carriers)** | P1 |
| 3 | Render Hub test data cleanup | **Safe procedure derived from existing wipe code** | P1 |
| 4 | Repo temporary/AI/artifact files | **Confirmed (16 MB of committed dumps/output)** | P1 |
| 5 | Clean-build = first-use guarantee | **Achievable; needs a defined cleaning checklist** | P1 |
| 6 | Upgrade vs uninstall | **Upgrade path is correct by design; two gaps remain** | P1 |
| 7 | Newly discovered release blockers | **6 additional findings** (2 high) | — |

---

# Problem 1 — Factory Reset / "Restore Session" Dead-End

## 1.1 Root cause (exact)

The factory reset is defined too narrowly. `apply_requested_factory_reset` (`desktop/src-tauri/src/runtime/stack.rs:160-176`) does exactly three things: renames the `data/` directory aside via `move_data_aside`, deletes the request flag, and restarts. Everything that decides the next boot's startup state and the SPA's first screen is left behind:

1. **Leftover prior-data evidence.** `prior_data_evidence` (`db_meta.rs:308-322`) treats a leftover `pgdata/` directory (line 312: `app_data_root.join("pgdata").exists()`) — the old PostgreSQL-era cluster that survives the reset because `move_data_aside` never touches it — and a root-level `data-integrity.json` with `business_rows > 0` as proof of prior company data. On the very next boot `evaluate_startup_state` (`db_meta.rs:336-342`) therefore returns **`DataMissing`** instead of `Fresh`.
2. **Silent best-effort rename.** The manifest move inside `move_data_aside` is `let _ = fs::rename(...)` (`stack.rs:211`) — it fails silently. A manifest that failed to move is then read as a live manifest, producing the same `DataMissing` escalation.
3. **`DataMissing` offers only unusable options.** `db_meta.rs:291` defines the `DataMissing` choices as exactly `[restore_backup, locate, start_new]`. `restore_backup` needs a backup ZIP the operator does not have (their data is intact in `data.reset-*`, not a restorable archive); `locate` needs a `motard.db` file. Hence "no usable options."
4. **The recovery screen.** `main.rs:84-108,196-211` (`ask_user`) renders the Tauri recovery window with `desktop/src-tauri/resources/server/web/recovery.html:75` — "جارٍ استعادة التشغيل…" — which is the dead-end screen the app reopens into after the reset-triggered restart (`main.rs:972-980`: `apply_factory_reset_now` writes the flag then `app.restart()`).
5. **WebView2 localStorage survives.** Auth tokens and license markers live in localStorage (`src/infrastructure/auth/TokenProvider.ts:3-4`; `src/lib/license-state.ts:6-8`): `erp.auth.accessToken/refreshToken`, `erp.license.key/activationId/hostname`, `installTenantId`. The Rust reset never clears them, so the reopened SPA holds a stored session and an "activated" license marker against an empty database.
6. **Session restore masks the empty DB.** `JWT_SECRET` comes from `secrets.dat` (`stack.rs:676-688`), which also survives the reset — so the stored token *verifies*. `/api/auth/me` on the fresh DB answers **401 UNAUTHORIZED "user not found"** (`backend/src/presentation/routes/auth.route.ts:215-218`) because no user exists. `AuthGate.tsx:37-51` shows the second "جاري استعادة الجلسة…" spinner, then falls to `UserPickerPage`, whose device-roster call returns **503 SETUP_REQUIRED** (`auth.route.ts:460-476`) because the fresh DB has no completed `installation_state` — a second dead-end.
7. **Reinstall cannot fix it.** Every stuck piece (`pgdata/`, WebView localStorage, `secrets.dat`, `data.reset-*`) lives in AppData, not the install dir — the same survival-in-AppData mechanism already proven as P-4 in `docs/PRD-DESKTOP-SQLITE.md:35`.

**Git window:** `5df80b11` ("SQLite desktop engine") switched the runtime to `data/` + SQLite but left the `pgdata` check in `db_meta.rs:312`; `f2b8b263` introduced session-restore handling. The factory-reset tests (`stack.rs:1009-1056`) only assert the flag is consumed and the archive exists — no test covers `evaluate_startup_state` *after* a reset on a root containing `pgdata` or an unmoveable manifest, which is exactly the regression window.

## 1.2 Affected files / components

| Component | File |
|---|---|
| Reset execution + archive | `desktop/src-tauri/src/runtime/stack.rs:160-231,972-980,1009-1056` |
| Startup state machine | `desktop/src-tauri/src/db_meta.rs:19-21,27-33,291,308-322,336-342,361-401` |
| Boot / recovery prompt | `desktop/src-tauri/src/main.rs:84-108,196-211,305-342,957,972-980` |
| Recovery UI | `desktop/src-tauri/resources/server/web/recovery.html:75` |
| Frontend session gate | `src/infrastructure/auth/TokenProvider.ts`, `src/lib/license-state.ts`, `src/lib/AuthGate.tsx` (UserPickerPage) |
| Backend gates | `backend/src/presentation/routes/auth.route.ts:201-230,460-476` |

## 1.3 Dependencies

- `secrets.dat` (DPAPI JWT/APP keys) is per-install and intentionally preserved by reset (`main.rs:957`) — the fresh server needs it.
- `device-binding.dat` (DPAPI install identity) is likewise preserved by design.
- The SQLite build still carries the PostgreSQL-era check in `db_meta.rs:312`.
- Frontend `AuthGate` and `UserPickerPage` share the token/license storage keys listed above.

## 1.4 Risk

**P0 — user-facing data-state dead-end.** After a reset (and on upgraded machines with leftover `pgdata`), every path offered is unusable; the operator perceives data loss even though the data is intact in `data.reset-*`. Also presents as an apparent "restore session" trap after reinstall. Blocks any customer delivery that relies on factory reset as a support tool.

## 1.5 Precise fix (do NOT implement yet)

Correct state model — treat factory reset as **one atomic transition across three scopes**:

- **Per-company (archived):** `data/`, `db-meta.json`, `data-integrity.json`, hub pairing (`hub.json`, `hub-session.json`, `hub-credentials.dat`), prior-data evidence.
- **Per-device (cleared):** WebView2 localStorage `erp.auth.*`, `erp.license.*`, `erp.sync.deviceId`; `device-binding.dat` if a truly new device is desired.
- **Per-install (preserved):** `secrets.dat`, install-instance marker, update token.

Concrete changes:

1. **`stack.rs` / `move_data_aside`:** archive `pgdata` and all prior-data evidence together with `data/`; make the `data-integrity.json` rename mandatory (propagate the error, drop `let _`); after success write a **reset receipt** (`factory-reset.done` containing the archive path) that `evaluate_startup_state` consults.
2. **`db_meta.rs` / `prior_data_evidence`:** stop counting engine-obsolete `pgdata` as prior-data evidence on a SQLite build (or treat it as explained when a `data.reset-*`/receipt exists); treat an unmoved `data-integrity.json` after a receipt as part of the reset, not a live manifest.
3. **`main.rs` / reset command:** after the archive succeeds, wipe the WebView2 profile/localStorage keys (`erp.auth.*`, `erp.license.*`, sync device id) before restart.
4. **Frontend:** on cold open validate first — if `/api/auth/me` answers 401 "user not found" or the device-roster answers 503 SETUP_REQUIRED, clear tokens + license markers immediately and route to the setup/activation wizard; never render "جاري استعادة الجلسة…" unbounded and never reach the picker in a dead-roster state.

## 1.6 Validation / acceptance tests

1. **Rust unit:** temp root containing `pgdata/` (with `PG_VERSION`), `data/motard.db`, `db-meta.json`, `data-integrity.json`; write `factory-reset.requested`; run `apply_requested_factory_reset`; assert `evaluate_startup_state` → `StartupState::Fresh` (fails today at `db_meta.rs:312`). Extend `stack.rs:1009` test likewise.
2. **Frontend:** pre-seed localStorage tokens + license markers, server returns 401/SETUP_REQUIRED (mirror `session-failure.test.ts`); mount gates; assert bounded settle on the setup screen with tokens cleared — never the spinner or roster-less picker.
3. **E2E on a machine with leftover `pgdata`:** typed-phrase reset → restart → boot log `STARTUP_STATE=FRESH` → setup wizard appears; after reinstall on the same machine, setup completes with no `recovery.html` prompt.

---

# Problem 2 — Clean Local Test Data (Desktop)

## 2.1 Root cause / current state

The dev machine's data roots accumulated real dev-era business data, and the repo carries several test-data carrier files. Per `desktop/src-tauri/src/lib.rs:32-36`, release builds use `%LOCALAPPDATA%\motard-erp`, debug builds `%LOCALAPPDATA%\motard-erp-dev` — plus the WebView2 profile `%LOCALAPPDATA%\com.motardfabrics.erp`. A FRESH boot (`db_meta.rs:336-341, 8-16`) requires an **empty** data root; `prior_data_evidence` (`db_meta.rs:307-322`) escalates to `DataMissing`/prompt on `db-meta.json`, `pgdata/`, or an integrity manifest with `business_rows>0`.

## 2.2 Runtime artifacts to clean (dev machine)

Delete these directories/values (nothing inside them is required-to-keep; the FRESH state machine bootstraps from an empty root):

- `%LOCALAPPDATA%\motard-erp\` — entirely: `data\motard.db` (+`-shm`/`-wal`), `db-meta.json`, `data-integrity.json`, `pending-update.json`, `backups.json`, `backups\`, `set-aside\` (`utc-1791200765`, `utc-1791394607`), `data.reset-utc-1791394599`, **`pgdata\`** (retired PostgreSQL leftover — prior-data evidence trigger), `hub.json`/`hub-session.json`/`hub-credentials.dat`, `device-binding.dat`, `secrets.dat`, `install-id`, `cluster-identity.txt`, `motard.lock`(+`.owner`), `db-port.txt`, `logs\`, `server.log*`, `forensic-pg.err/log`
- `%LOCALAPPDATA%\motard-erp-dev\` — entire dev-profile twin (same file set)
- `%LOCALAPPDATA%\com.motardfabrics.erp\` — WebView2 profile (localStorage sessions, tokens, license markers)
- `HKCU\Software\MotardFabricsErp\InstallInstanceId` — installer-written marker (`db_meta.rs:36-37`, `hooks.nsh:28-34`)

## 2.3 Repo files that are test-data carriers

| File/Dir | Status | Action |
|---|---|---|
| `backup\erp-dev-20260905-170828.dump`, `erp-dev-pre-rls-20260905-195632.dump`, `backup\pgdump-staging\`, `backup\_verify_*.sql` | ignored (`/backup/`, `.gitignore:95`) — 84 MB PG-era dev-business snapshots | Delete from disk |
| `backend\sync-test-a.log` … `sync-test-hub.log` (5 files) | ignored (`backend/.gitignore:4`) | Delete from disk |
| `logs\erp.1.log`, `erp.2.log` | ignored (`.gitignore:2`) | Delete from disk |
| `test-results\` | ignored (`.gitignore:28`) — cert-audit artifacts naming test records (INV-2863, fabrics, parties) | Delete from disk |
| `backend\seed-test-admin.mjs` | tracked, self-guarded (`NODE_ENV=test` / `ALLOW_TEST_SEED=1`) | **Keep** (tool, not data) |
| `backend\scripts\seed-test-baseline.mjs` | tracked, idempotent, `erp_test` only | **Keep** (tool) |
| `backend\bootstrap-hub.mjs`, `backend\reset-hub-admin.mjs` | tracked, one-shot manual tools | **Keep** (tools) |
| `backend\.env` | gitignored; **contains live secrets** (JWT_SECRET, APP_MASTER_KEY, LICENSE_SIGNING_KEY) | **Keep — required by product** (see §5.3) |

## 2.4 Required to keep (do NOT clean)

- `backend\.env` `LICENSE_SIGNING_KEY` + `LICENSE_SIGNING_PUBLIC_KEY` — `desktop/scripts/build-desktop-seed.mjs:45-66` requires the shipped `resources/license-public.pem` to pair with this key; rotating invalidates issued offline licenses.
- `desktop\build-frontend.cmd:19` — `VITE_DEFAULT_TENANT_ID=407fccfc-ba89-41c5-b5b9-ddb2c4f385d9` (seed tenant constant).
- Desktop seed machinery: `build-desktop-seed.mjs`, `bundle-server.mjs`, `stage-node-runtime.mjs` outputs (regenerated each build; `desktop/src-tauri/resources/` is gitignored, `.gitignore:81`) — the shipped `desktop-seed.json` contains exactly one default tenant + one signed active offline license, **no users** (`build-desktop-seed.mjs:81-90`).

## 2.5 Validation

After cleaning, run the release build → install on a wiped machine → assert: setup wizard appears; `db-meta.json` shows FRESH; boot log `STARTUP_STATE=FRESH`; no invoices/fabrics/parties beyond the seed tenant; no `erp.auth.*` in localStorage before activation; no hub pairing files until pairing is performed.

---

# Problem 3 — Clean Render Hub Test Data

## 3.1 Current state

Hub: Render Postgres `motard-sync-test1` + Redis + API service `ME`. **No dedicated hub-wipe script exists** — `bootstrap-hub.mjs` only seeds a new tenant; `reset-hub-admin.mjs` only resets one admin password. A one-off wipe script must be written, following the proven in-repo patterns.

## 3.2 Safe wipe procedure (per-tenant, transactional)

Pattern sources (already in repo):
- FK-safe delete order: `backend/scripts/restore-from-backup.mjs:220-230` — business tables first, then sync state with children of `sync_devices` deleted **before** `sync_devices`.
- RLS context: `backend/scripts/durability-proof.mjs:120-188` — `set_config('app.current_tenant_id', tenant, true)` + `set_config('app.platform_mode','on',true)` + `SET LOCAL row_security = off` + per-table SAVEPOINTs. Commit `7314c174` proves RLS tenant context is mandatory for device-row operations (`FORCE RLS` applies to the table owner — `bootstrap-hub.mjs:32`).
- Trigger handling: `restore-from-backup.mjs:264-280` — must `DROP TRIGGER trg_ledger_entries_append_only` inside the transaction and recreate after; otherwise the wipe fails halfway on `ledger_entries`.
- Sequence reset: `restore-from-backup.mjs:257-262` — after wiping, `setval` past old max on `sync_outbox.seq`, `sync_inbox.received_seq`, `audit_logs.id`, `idempotency_keys.id` (also `docs/SYNC-OPERATIONS.md:110`).

**Step-by-step plan:**

1. **Pre-verify:** `GET /api/sync/status` + `GET /api/sync/claims` — all claims must be terminal (`dead`); reap via `POST /api/sync/claims/reap` first (`docs/SYNC-OPERATIONS.md:13,45-50`). Confirm the connecting role owns the tables or has BYPASSRLS (needed to drop/recreate the ledger trigger, `docs/SYNC-OPERATIONS.md:117-124`).
2. **Decide tenant strategy (RECOMMENDED):** **keep the existing tenant row** and wipe only business + sync + licensing-per-tenant rows. Recreating a tenant via `bootstrap-hub.mjs` mints a NEW tenant UUID, which would orphan live-device pairing and reserved `document_number_blocks`. (Alternative: full tenant retirement + `bootstrap-hub.mjs` re-seed, only if no live device is paired.)
3. **Wipe (one transaction, tenant-scoped):** business tables — `stock_movements, invoice_lines, return_lines, order_items, print_jobs, vouchers, returns, orders, ledger_entry_archive, yearly_party_summaries, ledger_entries, day_closes, manual_movements, cashbox_sessions, cashbox_daily_balances, expenses, financial_operations, notifications, idempotency_keys, attachments, audit_logs, rolls, colors, fabrics, parties, inventory_counts`. Sync state — `sync_conflicts → sync_tombstones → sync_resource_claims → sync_inbox → sync_outbox → document_number_blocks → sync_state → sync_devices` (exact order, per `restore-from-backup.mjs:220-230`). If retiring the tenant: also `license_activations`, `license_audit_events`, `device_registrations`, `settings`, `company_profiles`.
4. **Recreate bootstrap rows** (if tenants were wiped): `bootstrap-hub.mjs` (tenants, licenses full/active max_devices 10, admin user argon2id 64MB/t3/p4, `setup_wizard_state` with **`is_completed=true`** — `bootstrap-hub.mjs:39-64`; without it every install-gate request is refused with SETUP_REQUIRED). If tenant kept but admin lost: `reset-hub-admin.mjs <email> <password>`.
5. **Reset sequences** (step 1 list) with `setval`.
6. **Post-verify:** counts = 0 for parties/invoices (`durability-proof.mjs` verification pattern); `/api/auth/*` and `/api/sync/*` respond normally; `setup_wizard_state.is_completed = true`.

## 3.3 Infrastructure NOT to touch

Render service `ME` + env (`DATABASE_URL`, `REDIS_URL`); Redis (only TTL'd `denylist:<jti>` and idempotency fast-path keys — `TokenDenylist.ts:25,60-77`; `idempotency.middleware.ts:52,112`; DB `revoked_tokens` is source of truth — `migration 0052`; optional `FLUSHDB` harmless); all migrations/RLS policies (`20260914_sync_rls_canonical_policies.sql`, `20260923_force_rls_all_tenant_tables.sql`, `0029_rls_hardening.sql`); `fn_ledger_entries_append_only` trigger (dropped only inside the wipe tx, recreated immediately); `system_admins` table (platform-level, `migration 0005:10`); Dockerfile / docker-compose / `backend/deploy/nginx`.

## 3.4 Sync-table caution

`docs/SYNC-OPERATIONS.md:88-96`: the sync tables are durable production state — wipe them **with** the business tables, never independently (truncating inbox re-opens double-apply; resetting `sync_state` re-pulls history; dropping claims re-opens decided conflicts). After wiping `sync_devices`/`device_registrations`, every paired live device must re-register via `POST /api/auth/sync-device` — otherwise pushes stall with 403 `SYNC_UNKNOWN_DEVICE` (`docs/SYNC-OPERATIONS.md:145-152`). Number blocks re-carve automatically on the next `/api/sync/run`.

## 3.5 Validation

Pre/post counts per table = 0 (business, sync); hub `/api/sync/status` healthy; a test device re-pairs and pushes one invoice which materializes; admin login works; no orphan FK rows (run `backend/scripts/reconcile-integrity.mjs`).

---

# Problem 4 — Project File Cleanup

## 4.1 Committed bloat (tracked in git — needs a removal commit)

| Path | Size | Status | Verdict |
|---|---|---|---|
| `scripts/parity/out/` | 889 files, **12 MB** test-run output (diff.txt, desktop-seed.json, durability-sqlite/report.json) | tracked, **not gitignored** | **Remove from tracking + add to .gitignore** |
| `docs/durability-proof/` | 41 files, **4.8 MB** raw ndjson dumps (`dump-2026-10-01T*`) | tracked | **Remove raw dumps from tracking** (keep `docs/DURABILITY-PROOF-RESULTS.md`, which is the real evidence record) |
| `scripts/parity/baseline/ref/` | 67 files, 940 KB frozen PostgreSQL reference | tracked; README says the frozen baseline is intentional | **Keep** (deliberate parity input) |
| `my-project/.specify/` | 20 files speckit scaffolding from a throwaway dir name | tracked | **Remove** (verify `specs/` docs first) |
| `desktop/retired-postgres/scripts/` | 5 tracked files, superseded PG-era code | tracked | **Keep for now** (referenced by build gates; mark for later retirement) |
| `bunfig.toml` | 463 B; repo uses npm, no bun references in package.json | tracked | **Remove** |
| `skills-lock.json` | 259 B AI/skill lockfile | tracked | **Remove** (AI tooling) |
| `ERP_GENOME.md` | 38 KB agent-generated system map | tracked | Decision: keep (useful doc) or remove; **owner decision** |
| One-off AI plan docs (`TASK_PLAN_OPENING_BALANCE_AND_PRINT.md`, `AUDIT-V2-VERIFICATION.md`, `SYSTEM-FULL-AUDIT.md`, `CORRECTIVE-ACTION-PLAN-2026-10-07.md`) | tracked | Session notes superseded by `PROJECT-STATUS.md` convention | Owner decision — `PROJECT-STATUS.md:5-9` already establishes the single-source-of-truth rule |
| `hotpath/policy.toml` | tracked, referenced by hotpath docs | **Keep** |

## 4.2 Untracked disk-only cleanup (safe to delete from the working tree)

`backup\` (84 MB: `pgdump-staging` 83 MB, 2 `erp-dev-*.dump`, `_verify_*.sql` — `.gitignore:95`), `logs\` + `backend\sync-test-*.log`, `test-results\` (2.2 MB), `dist\` (5 MB, regenerated), `backend\dist\`, `.agents\`, `.claude\`, `backend\audit-logs\` if present, `desktop\logs\`, `desktop\src-tauri\retired-postgres\resources-postgres\` + `target-release-postgres\` (generated PG clusters, gitignored), `desktop\src-tauri\target\`, `node_modules\`.

## 4.3 Working-tree anomalies (do NOT delete — investigate first)

`git status` shows **untracked source dirs**: `.husky\`, `backend\lib\`, `backend\src\infrastructure\repository\`, `src\domain\value-objects\`, `src\infrastructure\config\`, `src\infrastructure\repositories\supabase\`. These may be real, uncommitted source. Before any cleanup: diff-review each; commit what is needed, delete only confirmed orphans (e.g. a `supabase` repository driver that nothing references).

## 4.4 .gitignore gaps

- `scripts/parity/out/` is not covered — add it.
- `backup/` rule is intentionally unanchored to protect `backend/src/infrastructure/backup/` (`.gitignore:89-95`) — keep as is.
- `desktop/src-tauri/resources/` correctly ignored (`.gitignore:81`, regenerated by build).

## 4.5 Validation

After cleanup: `git status` clean except intended source; `npm run check:all` passes; `npm run tauri:build` in `desktop/` succeeds (freshness + manifest gates green); repo size drops by ~17 MB of committed output.

---

# Problem 5 — Clean Desktop Release = First Use

## 5.1 What "first use" means exactly (boot-time state)

FRESH (`db_meta.rs:336-341`, prior_data_evidence `307-322`) requires an **empty** `%LOCALAPPDATA%\motard-erp`: no `device-binding.dat` (minted at step 0, `main.rs:311-314`), no `secrets.dat` (generated on first load, `secret_store.rs:159`), no `data\motard.db`, no `db-meta.json`, no `data-integrity.json`, no `pending-update.json`, no `backups.json`, no `pgdata\`, no `set-aside\`, no `hub.json`, no `logs\` — plus no `HKCU\Software\MotardFabricsErp\InstallInstanceId`. First-run content comes **only** from `resources/server/desktop-seed.json` (one default tenant + signed offline license, no users — `build-desktop-seed.mjs:81-90`), gated by `verify-build-freshness.mjs` and the FRESH e2e (`server-bundle.test.mjs:194-201`). Debug builds use `motard-erp-dev` (`lib.rs:32-41`), so dev state cannot leak into the release root — but a leftover `pending-update.json` would make a fresh-looking root behave as REUSE/adopt instead of FRESH; it must never be shipped (it is not — `resource-manifest.json` lists only node.exe, server/, license-public.pem).

## 5.2 Checklist for a clean release build

1. Dev machine data roots cleaned per §2.2 (or better: build/verify on a machine or VM without them).
2. `desktop/src-tauri/resources/` regenerated fresh by `bundle-server.mjs` + `build-desktop-seed.mjs` (build gates: `dfp001-staging-gate.test.mjs:34-36` order — bundle → seed → e2e → manifest → no-postgres → freshness; `build-release.cmd:14,29` runs the freshness gate post-build).
3. Version bump applied to **all** manifests (see finding F5 below — root `package.json` is still 2.0.2).
4. `npm run check:all` green; `cargo test` green in `desktop/src-tauri`; installer built via `npx tauri build`.
5. Smoke: install on a wiped machine → FRESH state, setup wizard, seed tenant only, no hub pairing, no sessions.

## 5.3 Build prerequisite to preserve

`backend\.env` `LICENSE_SIGNING_KEY` + public key must be the **same keypair** as the shipped `resources/license-public.pem` (`build-desktop-seed.mjs:45-66`). Do not regenerate for a release build. `LICENSE_SIGNING_KEY` is enforced at boot in production (`backend/src/infrastructure/config/env.ts:195-199`; generation tool `npm run license:genkey -- --write` documented in `backend/.env.production.example` — no missing requirement found).

---

# Problem 6 — Installer Update vs Uninstall

## 6.1 What is already correct (by design)

- **Data is never deleted by the uninstaller.** `desktop/src-tauri/windows/hooks.nsh:16-24,37-41`: "Uninstall ≠ Delete User Data: Do NOT delete `%LOCALAPPDATA%\motard-erp`"; `NSIS_HOOK_PREUNINSTALL` deletes only the HKCU autostart Run value and the `InstallInstanceId` marker; `POSTUNINSTALL` is intentionally empty (`hooks.nsh:43-45`). No `deleteAppDataOnUninstall`-style setting appears in `tauri.conf.json`.
- **Over-install preserves the marker.** `NSIS_HOOK_POSTINSTALL` (`hooks.nsh:26-35`) writes a NEW GUID to `HKCU\...\InstallInstanceId` **only if absent** — an update re-runs the installer and keeps the marker.
- **Two independent REUSE paths if the marker is lost:** `pending-update.json` hand-off token naming the recorded instance + `to_version == running_version` (`db_meta.rs:386-390`), and REUSE-adopt when the running binary version is NEWER than `motard_meta.app_version_last_opened` (`db_meta.rs:391-401`).
- **In-app update path is protected:** `install_desktop_update` (`main.rs:889-938`) refuses to update without a VERIFIED pre-update backup (`main.rs:895-907`), writes `pending-update.json` before a graceful server stop with `wal_checkpoint(TRUNCATE)` and data-lock release, then runs the updater in passive mode (`tauri.conf.json:68-76`).
- **Startup state machine is read-only** (`db_meta.rs:19-21,405-440`): it never deletes; "start new" archives to `set-aside\<timestamp>` which is undoable (`main.rs:520-529`). `Tampered` device binding refuses boot (`device_binding.rs:44-45`).

## 6.2 Gap 1 — same-version / downgrade reinstall feels like an uninstall

A manual re-run of the same `setup.exe` uninstalls first (NSIS default), removing the marker; the version-newer adopt rule does **not** trigger for equal versions → `PRIOR_DATA_FOUND` prompt (`db_meta.rs:371-402`). Data is never deleted, but the operator is asked "prior data found" on what should be a routine repair install. **Fix:** record `last-installed-version` in HKCU before uninstall and treat "marker absent + same version + pending-update.json" (or marker-rewrite path) as REUSE-adopt; or write `pending-update.json` on shutdown so same-version reinstalls hit the token path.

## 6.3 Gap 2 — manual setup.exe over-install has no safety rails

The in-app updater gets a verified pre-update backup + WAL checkpoint, but a **manual** `setup.exe` over-install has neither: no installer hook runs the app's pre-update backup, and Windows NSIS replaces the install dir while `motard.lock` may still be held if the app is open (co-launch is handled at runtime, `main.rs:480-503`, but the installer itself relies only on Tauri's default running-instance check). **Fix:** add an `NSIS_HOOK_PREINSTALL` that refuses to run while the app process or `motard.lock` exists, document "close the app before installing," and (optionally) have the installer trigger a backup request on next boot when it detects an over-install.

## 6.4 Validation / acceptance test (upgrade preserves everything)

1. Install release vN; launch; complete activation; create company data (invoices/parties/rolls/settings); pair hub; record hash of `%LOCALAPPDATA%\motard-erp\data\motard.db` + snapshot of the AppData tree.
2. Quit cleanly (lock released, WAL checkpointed).
3. Run vN+1 `setup.exe` silently (`/S`, currentUser mode).
4. Launch vN+1 → expect state REUSE (marker kept by POSTINSTALL or version-newer adopt); assert `motard.db` hash unchanged; `db-meta.json`, `secrets.dat`, `device-binding.dat`, `hub.json`, `backups\`, `set-aside\` untouched; business rows visible in UI; sessions/licensing/settings intact (all in-DB: `db_meta.rs:189-208`).
5. Negative test: **uninstall then reinstall** vN+1 → expect `PRIOR_DATA_FOUND` prompt (not silent takeover), then "open existing" keeps data with adopt.
6. AppData tree snapshot before/after must show **zero deletions**; install dir fully replaced (freshness manifest).

---

# Problem 7 — Newly Discovered Release Blockers

## F1 — Desktop auto-update can never fire (HIGH)

`desktop/src-tauri/tauri.conf.json:60` sets `"createUpdaterArtifacts": false` → no signed updater artifact is ever produced, and **no script in the repo publishes `latest.json`** (enumerated `scripts/`, `desktop/scripts/`; only references are the hard-coded endpoint `https://updates.motardfabrics.com/desktop/latest.json` in `tauri.conf.json:70` and `backend/src/presentation/routes/license.route.ts:117`). Tauri's updater requires a signed artifact; a hand-made unsigned `latest.json` fails signature verification against `plugins.updater.pubkey` (`tauri.conf.json:73`). Consequence: shipped installs silently never update; a future force-upgrade policy could lock users out. **Fix:** set `createUpdaterArtifacts: true`, publish signed artifact + `latest.json` via a documented script, and validate the full path on a real 2.0.2 install. **Validation:** build produces a `*.sig`; `check_desktop_update` → `install_desktop_update` bumps the version.

## F2 — 8 durability scenarios recorded NOT_RUN (HIGH)

`docs/DURABILITY-PROOF-RESULTS.md:72-79`: D1-PG-FAST (harness hung), DESKTOP-NORMAL-EXIT, DESKTOP-FORCE-KILL, DESKTOP-WIN-SHUTDOWN, DESKTOP-NODE-CHILD-KILL, NSIS-REINSTALL-LIVE — all NOT_RUN, i.e. status UNKNOWN by the doc's own evidence rule, and the doc predates the 2.0.3 SQLite build (commit `5cc228a1`). The core durability claims are unproven for the exact binary being shipped. **Fix:** re-run the durability harness against the packaged 2.0.3 EXE (at minimum force-kill mid-write and node-child-kill mid-transaction) and record results. **Validation:** rows flip to PASS with captured artifacts.

## F3 — Dye purge is sync-exempt with unverified FK residue (HIGH)

`docs/SYSTEM-FULL-AUDIT.md:39,725` (R8): dye purge bypasses sync (no sync ops recorded) and soft-blocks only some dependent tables; the full FK matrix was never exercised. A purge on the desktop silently diverges from the hub — hub keeps rows the desktop deleted, so sync/reconciliation can resurrect or orphan inventory/financial rows. **Fix:** sync purge effects to the hub, or hard-block purge while any device is enrolled and un-synced; enumerate/block/reconcile all dependent FK rows (orders, returns, prints). **Validation:** purge a fabric with live orders/returns/prints on a sync-enrolled device; diff desktop vs hub after sync; assert zero orphans and convergence.

## F4 — Desktop SQLite money columns still INTEGER (MEDIUM)

`docs/money-representation.md` (update 2026-08-23): migration 0037 moved PostgreSQL money to `NUMERIC(14,2)` with `round2dp` parity. But the bundled SQLite fingerprint (`desktop/src-tauri/resources/server/sqlite-migrations/meta/schema-fingerprint.json`, journalIdx 4) declares `INTEGER` for `expenses.amount`, `day_closes.opening_balance/total_in/total_out/expected/counted/difference`, `cashbox_daily_balances.closing_balance`, `cashbox_sessions.opening_balance`. SQLite INTEGER columns reject fractional input the same way the PG BIGINT columns did (the exact SQLSTATE 22P02 class documented for pre-0037). **Fix:** confirm whether desktop-side 2dp money is intentionally out of scope; if fractional USD must work on desktop, add SQLite migrations converting money columns and regenerate the fingerprint, or validate/round at the write path. **Validation:** on a desktop install, insert a 1.5 USD expense and a fractional-discount invoice; assert exact storage or document the integer policy.

## F5 — Version drift: root `package.json` 2.0.2 vs desktop 2.0.3 (LOW)

`package.json:3` = 2.0.2; `desktop/package.json:4`, `tauri.conf.json:4`, `Cargo.toml:3` = 2.0.3; `backend/package.json:3` = 0.1.0. The update gate (`backend/src/domain/licensing/updatePolicyGate.ts`) receives the client version; a mismatched source could mis-state the running version in any flow that reads the workspace version instead of `CARGO_PKG_VERSION`. **Fix:** bump root to 2.0.3 (decide the backend `0.1.0` policy) and add a CI check asserting version equality across manifests. **Validation:** the version the frontend reports to `/api/license/updates/status` equals the installed binary version.

## F6 — Install-tenant resolution has no server-side source; second-device dead-end risk (MEDIUM)

`src/lib/license-state.ts:157-165` documents the open item itself: install tenant id is per-browser local state; a second device opening the same install falls back to the env default, and `auth.route.ts` carries a TODO for host-based resolution. Commit `0e48fedd` covers only admin-disabled rows, not this path. **Fix:** expose the tenant id via `/api/setup/status` (authed) or implement host-based resolution; delete the TODO. **Validation:** complete owner sign-in and setup on a second enrolled device with no local `erp.auth` storage and no env tenant default.

## F7 — DR runbook does not carry the audit's known-unknowns (MEDIUM)

`docs/SYSTEM-FULL-AUDIT.md:632,674-681`: wrong factory reset, interrupted restore mid-swap, restore into mismatched app version without migrations, device-bound table exclusion/re-pair UX, sleep/hibernate rows 3-4, WebView2 crash — all UNKNOWN/PARTIAL; `docs/DISASTER-RECOVERY.md` contains **no gap/risk/not-verified section at all**. **Fix:** before release, exercise restore-into-mismatched-version and interrupted-restore on a packaged install; document sleep/hibernate behavior; add the UNKNOWN matrix to DISASTER-RECOVERY.md as explicit procedures. **Validation:** each scenario gains a verified recovery procedure or an explicit block.

---

# Recommended Remediation Order

1. **Fix Problem 1** (factory reset state model + frontend gate) — P0, user-facing dead-end.
2. **Clean §2/§3/§4 data & files** — mechanical, zero product risk; do before the next build.
3. **Close upgrade gaps (§6.2/6.3)** + version unification (F5).
4. **Wire the updater (F1)** and re-run durability proof (F2) on the final binary.
5. **Decide/fix F3, F4, F6, F7** with the owner; each has a defined validation.
6. Final gate: full checklist §5.2 + §6.4 acceptance run + §1.6 factory-reset E2E before shipping.

*Nothing in this document has been implemented. Owner approval is required before any code, data, or file changes.*
