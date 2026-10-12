# Google Drive Archive — Execution Ledger

Plan: `.hermes/plans/2026-10-10_151200-google-drive-monthly-archive.md`
Mode: execution per STRICT EXECUTION MASTER PROMPT (2026-10-10). Working tree preserved; no commits without authorization.

## Baseline (Phase 0)

- Git: `main`, dirty tree = pre-existing user WIP + this feature's files only (`git status` verified; user changes untouched, no reset/stash/clean performed).
- Node v26.7.0. Baseline checks BEFORE changes: root typecheck ✅, backend typecheck ✅, `backend npm run test:sqlite` → **823 passed / 37 skipped (149 files)**.

## Architectural corrections vs. original plan (Phase 1, evidence-based)

- C1: Primary-device designation must live in the **replicated `settings`** (hub-synced, `syncCoverage.ts:81`), not a local-only row.
- C2: Token refresh = **Rust-hosted loopback token endpoint** (not env-at-startup).
- C3: New SQLite tables follow the **`motard_*` hand-written** convention (no PG counterpart).
- C4: SQLite `numeric(p,s)` stores **scaled integers ×10^s** — exporters emit `Number`-mapped values; verified by probe.

## Tasks

### T1 — Durable SQLite data model ✅

- `orm/sqlite/migrations/0005_drive_archive.sql` (motard_drive_folders, motard_drive_uploads, motard_drive_runs; STRICT, CHECK constraints, UNIQUE stable_key)
- journal entry appended (idx 5), fingerprint regenerated (60 tables)
- `schemas/drive-archive.table.ts` (hand-written, isoNow defaults) + index export
- `scripts/generate-sqlite-schema.mts` coverage: HAND_WRITTEN exclusion (motard_* convention)
- Verification: `typecheck:sqlite` exit 0; backup-v3 10/10 (fingerprint gate enforces correctness)
- Tests: covered via suite regressions.

### T2 — Pure archive core ✅

- `googledrive/archiveCore.ts`: root name, Arabic months, SECTIONS (12, real pages only), periodKeyOf, sanitizeSegment, archiveFileName, stableKeyOf
- Tests: `tests/drive-archive-core.test.ts` → **19/19** (incl. year-boundary, sanitization, dedupe key contract)

### T3 — Drive client ✅

- `googledrive/driveClient.ts`: findChild/createFolder/uploadSmall/uploadResumable/getFile/ping; retry on 5xx/429/rate-limit; DriveAuthError on 401; `redact()` strips Authorization + token JSON from errors; token supplied per call by `TokenProvider`
- Tests: `tests/drive-client.test.ts` → **12/12** (mocked fetch; no credentials)

### T4 — Folder organizer + upload queue ✅

- `googledrive/folderOrganizer.ts`: cached resolve-or-create root→year→month→section; stale-cache reconciliation via getFile
- `googledrive/uploadQueue.ts`: deterministic stable_key enqueue (UNIQUE), lease claim + expiry reclaim, fail→retry/backoff, auth→blocked, retry action, stats; business-date period assignment at enqueue time
- Tests: `tests/drive-upload-queue.test.ts` → **9/9** on real temp SQLite (dedupe, revision on content change, auth-block, retryable failure, expired-lease reclaim, two-device same event, Dec→Jan business dates)
- BUG FIXED during TDD: missing `DriveError` import in uploadQueue.ts (caught by tests)

### T5 — Exporters ✅

- `googledrive/exporters.ts`: RFC-4180 CSV + BOM; invoices by type (sale/entry) with real schema columns (number/date/partyName/total/paid/status); cancelled included + marked; expenses monthly CSV; no invented columns; notesInternal excluded
- Tests: `tests/drive-exporters.test.ts` → **7/7** (month boundary, totals re-summable = source sum, cancelled marker, BOM bytes, deterministic filenames)
- Verified scaled-integer numeric convention via DB probe (probe files deleted after use)

## Verification matrix status

| Area                                                                                                               | Status                                                                |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Archive structure (month names, boundaries, idempotent folders)                                                    | ✅ tested                                                             |
| Queue: dedupe, retry, lease expiry, restart-safety semantics                                                       | ✅ tested                                                             |
| Client: retry, auth failure, redaction, resumable                                                                  | ✅ tested                                                             |
| Exporters: real data, totals, month assignment                                                                     | ✅ tested                                                             |
| Primary-device ownership enforcement (coordinator.ts)                                                              | ✅ tested (6/6, fail-closed)                                          |
| Settings drive section replicated via hub                                                                          | ✅ implemented (PG migration 20261025 + SQLite 0005 + settings stack) |
| Full SQLite regression                                                                                             | ✅ 876 passed / 37 skipped / 0 failed (baseline 823)                  |
| OAuth PKCE (Rust): PKCE RFC vector, consent URL, redirect parse (CSRF, error), token body, token parse incl. error | ✅ 8/8 google_oauth tests; full cargo lib suite 103/103               |
| OAuth refresh-token persistence (DPAPI SecretStore)                                                                | ✅ fields added serde-default (old secrets.dat load unchanged)        |
| OAuth live connect flow (browser + loopback listener + real Google)                                                | ⛔ blocked: needs real OAuth client id + test account (external)      |
| Tauri IPC commands google_connect_*/google_get_access_token wiring                                                 | ⏳ pending (skeleton compiles; commands not registered yet)           |
| Settings screen / routes                                                                                           | ⏳ pending (T9)                                                       |
| Real Google account verification                                                                                   | ⛔ blocked on external test account + Cloud project                   |
| Full-suite regression                                                                                              | ⏳ final gate                                                         |

## Checkpoints

- All work is uncommitted in the working tree (per rules). Recovery = `git diff`/`git status`; feature files are disjoint from user WIP files.

## Schema-artifact note

- `orm/migrations/meta/schema-fingerprint.json` regenerated via the repo's own generator (`scripts/schema-fingerprint.mjs`) from a disposable DB migrated to PG journal head 102. Verified diff semantics: + settings.drive column, journalIdx 101→102, one function-hash difference (`sync_inbox_stamp_applied_seq`) which is a PG prosrc-whitespace artifact; all guards (fingerprint-committed, schema-type-parity, migration-contract) pass.

## Known limitations (honest)

- Google-side OAuth/Drive verification requires the owner's test account + Cloud project — NOT claimed done.
- PDF export pending decision: only print-template-backed types will ship PDF; CSV covers the rest.
- Consent-screen publishing (Testing mode = 7-day refresh tokens) is an external release blocker.

## Session end status (2026-10-10)

### Implemented and verified (all gates green)

- T1–T7 as above; OAuth core (PKCE vectors, consent URL, redirect/CSRF parse, token request/parse) in Rust with 8 unit tests; SecretStore extended with serde-default google_* fields (old secrets.dat loads unchanged — backward compatible).
- Gates at session end: backend typecheck 0 errors; root typecheck 0 errors; full SQLite suite 876/37skip/0fail; cargo lib 103/103.

### COMPLETION PASS (same day) — all locally achievable work done

- **Rust IPC complete**: `google_ipc.rs` — `google_configure/status/connect_start/connect_finish/access_token/disconnect` (loopback listener parked start→finish, bounded accept, PKCE exchange, cached token with −5 min proactive refresh, RFC 7009 revoke best-effort). Registered in `main.rs` as `google_*_cmd` thin wrappers (repo convention) + `GoogleState` managed. Desktop builds clean (`cargo build` Finished, `cargo test --lib` 103/103).
- **Backend API complete**: `drive.route.ts` — `/drive/status|test|sync-now|queue|queue/:id/retry`, all behind auth+admin; state-changing routes additionally fail-closed via `authorizeUploadDevice`. Sync-coverage guard satisfied with explicit exemptions (device-local operational control plane). Registered in `server.ts` (desktop+sqlite gated, non-fatal on failure).
- **Worker complete**: `monthlyArchiveJob.ts` — catch-up over 24 recent months (business-date discovery, only months WITH documents), lease-claim loop (≤25/pass), VERIFIED-automatic-backup-only enqueue (`enqueueVerifiedBackupUpload`), run bookkeeping in `motard_drive_runs`, unref'd timer, startup+6 h ticks. Tests: 6/6 incl. fail-closed NOT_COORDINATOR, no-duplicate re-runs, restart-with-pending, VERIFIED-only eligibility.
- **Frontend complete**: `src/lib/drive-archive.ts` (API + shell IPC) + `src/routes/settings.drive.tsx` (Arabic RTL: connect/disconnect/test/sync-now, status table, failed+blocked retry, desktop-only guard, ConfirmDialog). Nav entry (adminOnly) + routeTree.gen.ts regenerated.

### FINAL GATES (all executed, all green)

- backend typecheck: 0 errors | root (frontend) typecheck: 0 errors
- full SQLite suite: **882 passed / 37 skipped / 0 failed** (155 files)
- cargo test --lib: **103/103**
- Working tree: 37 changed/new files, all feature-related; user WIP untouched; no commits.

### REMAINING (external only)

1. Owner: create Google Cloud project + Desktop OAuth client id → paste into settings screen (`google_configure`).
2. Owner: publish consent screen (Testing mode = 7-day refresh expiry).
3. Owner: live connect with test account → verify folders/files in Drive → revoke → verify blocked-state UX.
4. Restore-from-Drive roundtrip: perform after first real backup upload (uses existing FullRestore flow).

### Rule compliance

- No commits/pushes; user WIP untouched; no business-rule changes; secrets never logged; no invented modules (sections map only to real pages); no production-readiness claim without live verification.
