# Google Drive Monthly Archive & Backup — Implementation Plan (ME-main)

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task. Read-only investigation done 2026-10-10; no code has been changed yet.

**Goal:** Add a customer-authorized Google Drive integration that archives each month's ERP documents (PDF + CSV) into `Motard ERP - أرشيف النظام/<year>/<2026-10 — أكتوبر>/…` and uploads VERIFIED database backups, with an idempotent persistent queue, offline resilience, and a coordinator lock for multi-device installs.

**Architecture:** The desktop app is a Tauri 2 shell (`desktop/src-tauri`) spawning the Express backend as a sidecar; the SPA reaches the API only via Tauri IPC → named pipe (`apiRequest` in `src/infrastructure/tauri-bridge.ts`) and the webview CSP (`connect-src 'self' ipc: http://ipc.localhost`) **cannot** reach `googleapis.com`. Therefore: OAuth loopback + all Drive HTTP run in the **backend sidecar (Node)**; tokens live DPAPI-encrypted in the **Rust secret store** and reach the sidecar only as spawn-time env vars (exactly how `JWT_SECRET`/`APP_MASTER_KEY`/`db_password` already flow — `secret_store.rs`). Queue/manifest state lives in **hand-written SQLite-only tables** (precedent: `motard-meta.table.ts`) so the PostgreSQL/shared schema and the generated-schema pipeline are untouched.

**Tech Stack:** Node 22, Express + Drizzle (better-sqlite3 desktop engine), Tauri 2 (Rust, DPAPI via `windows` crate), vitest (`backend/tests/`), Google Drive API v3 (`drive.file` scope), OAuth 2.0 authorization-code + PKCE (Desktop-app client, loopback redirect).

---

## Verified current-state facts (all inspected in-repo)

| Area                         | Fact                                                                                                                                                                                                  | File                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Desktop DB                   | SQLite v3 backup pipeline already does online-copy → integrity/FK check → VACUUM → zip+manifest → `.partial` → fsync → rename → verify → `VERIFIED`; restore is staged (VERIFY→SAFETY_BACKUP→…→SWAP)  | `backend/src/infrastructure/backup/sqliteBackup.ts`, `sqliteRestore.ts`      |
| Backup registry              | `backups.json`, statuses `CREATING→VERIFIED                                                                                                                                                           | FAILED`, atomic writes                                                       | `backend/src/infrastructure/backup/backupRegistry.ts` |
| Scheduler precedent          | Startup catch-up ("older than 24h") + interval timer; retention prune; weekly restore-test                                                                                                            | `backend/src/infrastructure/backup/sqliteBackupScheduler.ts`                 |
| Queue/lease precedent        | `sync_outbox` has `opId`, `status`, `leaseOwner/leaseToken/leaseUntil`, `claimedAt`                                                                                                                   | `backend/src/infrastructure/orm/sqlite/schemas/sync-outbox.table.ts`         |
| Secrets                      | DPAPI (CurrentUser, `CRYPTPROTECT_UI_FORBIDDEN`) → `%APPDATA%` `secrets.dat`; sidecar receives secrets via env at spawn                                                                               | `desktop/src-tauri/src/secret_store.rs`, `desktop/src-tauri/src/main.rs:114` |
| Desktop PDF                  | Headless Edge/Chromium `--print-to-pdf` from inlined HTML, per-doc-type Desktop folders (Arabic names), invoked as Tauri command `archive_document_pdf`                                               | `desktop/src-tauri/src/document_archive.rs`, `main.rs:373-397`               |
| Modules (real pages)         | sale/entry invoices, returns (sale/entry), orders, receipts, payments, cashbox, expenses, inventory + adjustments + counts, ledger/statements, reports, print-center, closing (year), settings.backup | `src/routes/*`, `backend/src/presentation/server.ts:14-60`                   |
| Settings nav                 | `src/routes/settings.tsx` tab list; new `settings.drive.tsx` slots in beside `settings.backup.tsx`                                                                                                    | `src/routes/settings.tsx:9-18`                                               |
| Schema pipeline              | PG schema is source of truth; `motard-meta.table.ts`-style SQLite-only tables are hand-written; fingerprint check via `npm run typecheck:sqlite`                                                      | `backend/src/infrastructure/orm/sqlite/schemas/motard-meta.table.ts`         |
| Tests                        | vitest in `backend/tests/*.test.ts` (151 files), SQLite harness `scripts/test-sqlite.mjs`                                                                                                             | `backend/package.json:14-28`                                                 |
| No existing OAuth/Drive code | confirmed — grep for oauth/drive/google across `backend/src` + `desktop/src-tauri/src` returns nothing relevant                                                                                       | —                                                                            |

---

## Phase 0 — Prerequisites outside the repo (must be confirmed before any upload works)

1. Google Cloud project with **Drive API enabled** and an **OAuth client of type "Desktop app"** (PKCE, no client secret needed at runtime; the client ID is not a secret for this flow but is still config, not frontend code).
2. Consent screen: while in **Testing** mode, refresh tokens expire after 7 days — the feature must not be called production-ready until the app is **Published/verified** or the customer runs an Internal/verified consent. This is a release prerequisite, not code.
3. A safe test Google account + a test Drive for all verification (per the brief).

## Phase 1 — Rust: OAuth + secure token storage

### Task 1.1 — Extend `SecretStore` with Google fields

**Files:** Modify `desktop/src-tauri/src/secret_store.rs` (+ its tests).

- Add `#[serde(default)] pub google_client_id: String`, `google_refresh_token: String`, `google_account_email: String` to `struct SecretStore`. Old `secrets.dat` files deserialize unchanged (serde default) — no migration.
- New unit tests: missing fields → defaults; roundtrip preserves them; existing test suite still passes (`cargo test` in `desktop/src-tauri`).

### Task 1.2 — OAuth 2.0 PKCE loopback flow (Rust)

**Files:** Create `desktop/src-tauri/src/google_oauth.rs`; register commands in `main.rs` `invoke_handler` (line ~373).

- `google_connect_start`: generate `code_verifier`/`code_challenge` (S256), bind an ephemeral `127.0.0.1:<port>` listener (one-shot), open the system browser at the Google consent URL (reuse the hidden-process/no-window spawn rules where applicable). Scope: **`https://www.googleapis.com/auth/drive.file` only** (+`openid email` for display). `access_type=offline`, `prompt=consent`.
- `google_connect_finish` (internal): exchange the code at `https://oauth2.googleapis.com/token`, store refresh token via `SecretStore`, return only account email + scopes granted to the UI. State parameter carries CSRF nonce; listener accepts exactly one request; PKCE verified at token endpoint.
- `google_disconnect`: clears the three fields (revocation call best-effort, failure does not block local disconnect).
- `google_status`: connected yes/no, email, scopes, token-present-without-value.
- Unit tests with a mocked token endpoint (loopback stub): PKCE S256 derivation, single-use listener, state mismatch refusal, secret never in returned strings.
- **Never log** tokens, codes, or verifier — grep gate in review; `eprintln!` hygiene consistent with existing code.

### Task 1.3 — Token hand-off to the sidecar

**Files:** Modify `desktop/src-tauri/src/main.rs` (sidecar spawn env, near line 114) and/or `desktop/src-tauri/src/runtime/stages.rs`.

- On spawn, inject `MOTARD_GOOGLE_CLIENT_ID` and, when connected, a **short-lived access token** (fetched by Rust from Google, ~1 h TTL) as `MOTARD_GOOGLE_ACCESS_TOKEN`. The sidecar never sees the refresh token; when the access token nears expiry the backend signals `TOKEN_EXPIRED` and Rust refreshes it (refresh happens only in Rust, DPAPI-protected at rest).
- Test: env var present when connected, absent otherwise; no token material in any log line (extend existing boot-log tests if any assert on env).

## Phase 2 — Backend: Drive client, folder layout, upload queue (SQLite-only tables)

### Task 2.1 — SQLite-only tables + migration `0005_drive_archive.sql`

**Files:** Create `backend/src/infrastructure/orm/sqlite/migrations/0005_drive_archive.sql`; create `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.tables.ts` (hand-written, following `motard-meta.table.ts` header rules); update `schemas/index.ts`.

- `drive_folder_cache`: `id, kind('root'|'year'|'month'|'section'), drive_file_id, parent_id, label, period_key('2026-10'|null), created_at` — durable folder-ID store (brief §14).
- `drive_upload_queue`: `id, stable_key (UNIQUE), entity_type, entity_id, period_key, section, file_name, mime, source_path, content_sha256, status('pending'|'uploading'|'done'|'failed'|'skipped'), drive_file_id, retry_count, next_attempt_at, last_error, created_at, updated_at, uploaded_at, device_id, lease_owner, lease_token, lease_until` — mirrors `sync_outbox` lease pattern.
- `drive_archive_runs`: `id, period_key, kind('documents'|'month_close'|'db_backup'), state, started_at, finished_at, detail` — month-close/backup bookkeeping.
- **Do NOT touch generated schema files or PG schema.** Verify with `npm run typecheck:sqlite` (regenerates fingerprint) inside `backend/`.

### Task 2.2 — Drive client (thin, mockable)

**Files:** Create `backend/src/infrastructure/googledrive/driveClient.ts`.

- Fetch-based (`undici`/global fetch) wrapper: `listFolder(q)`, `getByName(parentId, name)`, `createFolder`, `multipartUpload` (resumable for >5 MB), `downloadFile`. Exponential backoff on 5xx/403-rate-limit; `TOKEN_EXPIRED` surfaced as a typed error so the shell refreshes.
- Config from env only (`MOTARD_GOOGLE_CLIENT_ID`, `MOTARD_GOOGLE_ACCESS_TOKEN`). No token logging anywhere (`logger` redaction test).

### Task 2.3 — Folder organizer (names are pure functions)

**Files:** Create `backend/src/infrastructure/googledrive/folderLayout.ts` + `backend/tests/drive-folder-layout.test.ts`.

- Root `Motard ERP - أرشيف النظام` → year `2026` → month `2026-10 — أكتوبر` (Arabic month names table, Gregorian) → sections: `فواتير البيع`, `فواتير الشراء`, `المرتجعات`, `الطلبيات`, `المخزون والجرد`, `المقبوضات والمدفوعات`, `الصندوق والمصروفات`, `كشوفات الحسابات`, `التقارير`, `المرفقات`, `إغلاق الشهر`, `نسخ احتياطية لقاعدة البيانات` — mapped **only** to pages that actually exist (verified list above). `ensureFolderTree` is idempotent, caches IDs in `drive_folder_cache`, resolves by name on cache miss.
- Tests: month-name formatting incl. December→January boundary; cache hit/miss; no invented sections.

### Task 2.4 — Export renderers (per document type, real data only)

**Files:** Create `backend/src/infrastructure/googledrive/exporters/{invoices,payments,expenses,inventory,statements,reports}.ts`; tests in `backend/tests/drive-exporters.test.ts`.

- CSV (UTF-8 BOM, Excel-friendly) per section from existing repositories (invoice/party/date filters by business `date` column — `invoice.table.ts:14`); statements per party; reports in the same shapes the reports routes already produce. **No PDF invention in the backend**: printable PDFs reuse the existing print templates via the existing HTML→PDF path; where a document type has no print template, ship CSV only (report this mapping in the UI).
- Filename util (pure, heavily tested): `{docDate}_{docNumber}_{sanitizedPartyName}.{ext}` — sanitize `\ / : * ? " < > |` + control chars, trim, cap length, keep Arabic; collision suffix `-2`. Tests for all of the above.

### Task 2.5 — Idempotent upload worker

**Files:** Create `backend/src/infrastructure/googledrive/uploadQueue.ts` + `backend/tests/drive-upload-queue.test.ts`.

- Enqueue is **deterministic**: `stable_key = sha256(entity_type|entity_id|period_key|section|content_sha256)` → UNIQUE constraint makes duplicate events (double-fire, two devices exporting the same doc) no-ops (`INSERT ... ON CONFLICT DO NOTHING`).
- Worker loop: claim with lease (pattern of `sync_outbox`), `getByName` check before create (recovers crashes between upload and status write), status transitions, retry with backoff capped, `failed` surfaces error + `retry` action. Restart-safe: `uploading` rows with expired leases are reclaimed. Drive unavailability → rows stay `pending`, ERP transactions never touch this path (fire-and-forget enqueue only).
- Tests (vitest, mocked Drive): duplicate event dedupe; crash-after-upload no-dup; token-expiry → requeue not fail; offline → nothing blocks; retry count/backoff; month boundary assignment by business date not upload date.

### Task 2.6 — Month-close job + DB-backup job

**Files:** Create `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts`; modify `backend/src/infrastructure/backup/sqliteBackupScheduler.ts` only to expose a hook that notifies a successful new VERIFIED automatic backup (no behavior change otherwise).

- **Monthly documents pass:** on startup + every 6 h, compute uncovered months (latest `done` per section vs. business dates present) — catch-up covers "was offline at month end" (brief §15, same philosophy as the 24 h backup catch-up). Enqueues per-section CSV/PDF exports for each month.
- **Month close:** after a month is fully archived (or user clicks "إغلاق ورفع الشهر"), writes a `month_close` summary CSV + ledger snapshot into `إغلاق الشهر`. Reads-only; does **not** alter financial-year closing business rules (`year-closing.route.ts` untouched).
- **DB backup upload:** only `VERIFIED` v3 backup zips from `backupRegistry` are enqueued into `نسخ احتياطية لقاعدة البيانات` (they are already crash-safe, verified, and restorable — never a raw live-file copy). Retention note: local prune policy unchanged; Drive copies are the long-term retention (documented in settings screen).
- **Restore documentation** (UI info box + `docs/`): a Drive backup zip restores via the existing FullRestore flow (`FullRestoreCard` / `sqliteRestore.ts`) — test restore roundtrip already exists (`backup-restore-roundtrip.test.ts`) and must keep passing.

### Task 2.7 — Multi-device coordination

**Files:** Same worker; settings field `archive_coordinator`.

- Devices sharing a synced DB: uploads are keyed to ONE device — a `setting` row (`drive.archiveCoordinatorDeviceId`) settable in the UI; other devices enqueue only. If the coordinator is offline, another device may claim via lease takeover after `lease_until` expiry (same mechanism sync uses). Single-device installs are the trivial default.
- Test: two simulated devices, same stable key → one upload.

## Phase 3 — Frontend: settings screen

### Task 3.1 — `settings.drive.tsx`

**Files:** Create `src/routes/settings.drive.tsx`; register in `src/routes/settings.tsx` nav (`label: "أرشيف Google Drive"`, adminOnly); route tree regen (`routeTree.gen.ts` is generated).

- Cards: Connect/Disconnect (`google_connect_*` via `getInvoke()` — pattern of `src/infrastructure/tauri-bridge.ts`), Test Connection (lists root folder), Sync Now, status table (per-month per-section coverage from `drive_archive_runs`/queue counts), failed-uploads list with retry buttons, storage note + restore instructions.
- API endpoints (new `backend/src/presentation/routes/drive.route.ts`, registered in `server.ts` near line 51): `GET /drive/status`, `POST /drive/test`, `POST /drive/sync-now`, `GET /drive/queue?status=failed`, `POST /drive/queue/:id/retry`. All behind existing `auth`+admin guards. Explicit-consent gate: every endpoint that can upload checks `google_refresh_token` presence (never uploads before Task 1.2 completed authorization).
- Web build safety: screen shows "desktop only" when `isTauri()` is false.

## Phase 4 — Verification (evidence-based)

1. `cd backend && npm run test:sqlite` and targeted vitest runs for all new `drive-*.test.ts` (use plain/`--reporter=dot` — the `--reporter=basic` vitest-v4 ERR_LOAD_URL trap).
2. `npm run typecheck && npm run typecheck:backend && npm run typecheck:sqlite` in repo root/backend.
3. `cargo test` in `desktop/src-tauri`.
4. Manual, with the **test Google account**: connect → Sync Now on isolated test data → verify folder tree + filenames in Drive → kill app mid-upload → restart → no duplicates → revoke consent → verify `failed` states surface recoverable errors → restore a Drive-downloaded backup zip through FullRestore into a scratch data dir.
5. Confirm OAuth publishing status honestly in the final report; Testing-mode 7-day token expiry stated as a limitation if not yet published.

## Files expected to change (summary)

- **Create (Rust):** `google_oauth.rs` (+tests); **Create (backend):** `orm/sqlite/migrations/0005_drive_archive.sql`, `orm/sqlite/schemas/drive-archive.tables.ts`, `googledrive/{driveClient,folderLayout,uploadQueue,monthlyArchiveJob}.ts`, `googledrive/exporters/*.ts`, `presentation/routes/drive.route.ts`, `backend/tests/drive-*.test.ts`; **Create (frontend):** `src/routes/settings.drive.tsx`.
- **Modify (small, surgical):** `secret_store.rs`, `main.rs` (3 spots: env injection, invoke_handler, disconnect), `schemas/index.ts`, `server.ts` (one route registration), `settings.tsx` (one nav entry), `sqliteBackupScheduler.ts` (one notification hook).
- **Untouched:** all accounting/inventory/sync business rules, generated schema files, PG schema, backup format.

## Risks / open questions

1. **OAuth consent verification** — external customers need a published/verified consent screen; until then refresh tokens die weekly (Testing mode). _Release blocker; not solvable in code._
2. **PDF coverage** — PDF only where a print template exists; other records CSV-only. Over-promising PDFs for unsupported types would violate "do not export incomplete data".
3. **Client ID distribution** — one Google Cloud project (yours) vs. per-customer projects. Default: one project, customer authorizes their own account (their data lands in _their_ Drive via `drive.file`). Needs your confirmation.
4. **Loopback port for OAuth** — ephemeral port in Rust; firewall prompt possible on first connect (document it).
5. **Drive API quota** — 403 backoff implemented; large months with thousands of docs upload in batches across runs.
