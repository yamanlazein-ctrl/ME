# Google Drive, Hierarchical Archive, Cashbox Snapshots & Smart Merge Restore — Architecture Plan

Status: **PLAN ONLY.** No application code is changed by this document.
Scope: `desktop-app/src-tauri`, `backend/` (SQLite desktop engine unless stated), `packages/shared/`, `src/`.
Basis: code read on the current tree. Items marked **[VERIFY]** were not read in full and must be confirmed in the first task of the phase that touches them.

---

## 0. Ground truth the plan builds on

Verified facts that shape every decision below:

| #   | Fact                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Drive OAuth (PKCE + loopback) is implemented in Rust; refresh token is DPAPI-sealed; WebView never sees tokens                                                                                                                                                                                                             | `desktop-app/src-tauri/src/google.rs:1-11, 219-234, 287-315`                                                                                                                                   |
| G2  | The OAuth client ID and secret are **user-supplied** in the UI                                                                                                                                                                                                                                                             | `src/routes/settings.drive.tsx:185-219`; `google.rs:247-264`                                                                                                                                   |
| G3  | Email is already fetched from the `id_token` at connect and returned by status                                                                                                                                                                                                                                             | `google.rs:166-172, 236-244`; `settings.drive.tsx:178`                                                                                                                                         |
| G4  | Drive folder root is hard-coded `Motard ERP - أرشيف النظام`                                                                                                                                                                                                                                                                | `backend/src/infrastructure/googledrive/archiveCore.ts:8`                                                                                                                                      |
| G5  | Folder hierarchy is `root → YYYY → YYYY-MM — month → section` (no company name)                                                                                                                                                                                                                                            | `folderOrganizer.ts:89-97`; `archiveCore.ts:71-77`                                                                                                                                             |
| G6  | Drive exports are **CSV, header + one row per invoice**; no line items, no statements, no cashbox                                                                                                                                                                                                                          | `exporters.ts:76-108, 111-146`                                                                                                                                                                 |
| G7  | Drive upload always creates a new file; dedupe is by content hash, not by name → an edited invoice produces a second file with the same name                                                                                                                                                                               | `driveClient.ts:203-229` (`uploadSmall`); `uploadQueue.ts:71-116`                                                                                                                              |
| G8  | Monthly job re-exports 24 months every 6 h; there is no monthly schedule                                                                                                                                                                                                                                                   | `monthlyArchiveJob.ts:36-37, 136-156, 212-223`                                                                                                                                                 |
| G9  | Only the newest VERIFIED **automatic** DB ZIP is uploaded; it is read fully into memory                                                                                                                                                                                                                                    | `monthlyArchiveJob.ts:194-210` (`readFileSync`), `:94-106`                                                                                                                                     |
| G10 | Drive client has no download (`alt=media`) and no list-and-fetch                                                                                                                                                                                                                                                           | `driveClient.ts:183, 294, 307`                                                                                                                                                                 |
| G11 | Full DB restore is wholesale: stage → carry device state → swap → reopen                                                                                                                                                                                                                                                   | `sqliteRestore.ts:229` (`restoreBackupV3`), `:107` (`carryOverDeviceState`); `backup.route.ts:314-373`                                                                                         |
| G12 | Restore never merges; it replaces the company database                                                                                                                                                                                                                                                                     | `backup.route.ts:314-373, 648-672`                                                                                                                                                             |
| G13 | A local **HTML** archive exists (not PDF), written under `Desktop\<company>\` with 5 folders and no year/month                                                                                                                                                                                                             | `desktop-app/src-tauri/src/commands.rs:131-137` (`DOC_FOLDERS`), `:148-175` (`archive_root`, `ensure_document_folders`, `archive_document_pdf`); `src/components/print/printPortal.ts:220-269` |
| G14 | Browser print path is `window.print()` (manual dialog)                                                                                                                                                                                                                                                                     | `printPortal.ts:335`                                                                                                                                                                           |
| G15 | Cashbox page exists; no cashbox PDF or PNG export exists                                                                                                                                                                                                                                                                   | `src/routes/cashbox.tsx`; no `pdf`/`png` producer in Rust (`commands.rs` only has `archive_document_pdf`)                                                                                      |
| G16 | Tenant/company name source: `tenants.name` and `company_profiles.name`                                                                                                                                                                                                                                                     | `tenant.table.ts:10`; `company-profile.table.ts:11`; local archive already uses `settings.company?.name` (`printPortal.ts:252`)                                                                |
| G17 | Business tables carrying `version`: `invoices` (`invoice.table.ts:32`), `rolls` (`roll.table.ts:30`), `vouchers` (`voucher.table.ts:28`). Child tables `invoice_lines` (`invoice-line.table.ts:6-22`), `return_lines` (`return-line.table.ts:6-17`) and `ledger_entries` (`ledger-entry.table.ts:6-33`) have no `version`. | cited                                                                                                                                                                                          |
| G18 | Cashbox persistence: `cashbox_daily_balances` (PK tenant,currency,date; `cashbox.table.ts:6-16`), `cashbox_sessions` (`:18-29`), `day_closes` (`:31-47`, per currency via migration `0006`), `manual_movements` (`:49-65`)                                                                                                 | cited                                                                                                                                                                                          |
| G19 | Drive upload ledger tables are device-bound and excluded from backups                                                                                                                                                                                                                                                      | `sqliteBackup.ts:37-50` (`motard_drive_*`); `0005_drive_archive.sql` header                                                                                                                    |
| G20 | Two-engine rule: a repository change needs its Postgres twin; drive tables are SQLite-only by convention                                                                                                                                                                                                                   | `CLAUDE.md`; `0005_drive_archive.sql` header                                                                                                                                                   |
| G21 | Drive-archive routes are mounted only on desktop SQLite                                                                                                                                                                                                                                                                    | `server.ts:586-605`; `driveArchiveWiring.ts:20-64`                                                                                                                                             |
| G22 | Backup scheduler on desktop SQLite: 24 h + 7 retained + Documents mirror                                                                                                                                                                                                                                                   | `sqliteBackupScheduler.ts:1-12, 58-67`; `server.ts:807-813`                                                                                                                                    |
| G23 | Existing Rust PDF-related command returns HTML; the browser path builds an HTML archive document with embedded Arabic font CSS                                                                                                                                                                                             | `commands.rs:163-175`; `printPortal.ts:227-246` (`ARCHIVE_ARABIC_FONT_CSS` at `:240`)                                                                                                          |
| G24 | Print-doc paper/orientation CSS exists and is reusable                                                                                                                                                                                                                                                                     | `src/components/print/print.css:34`; `printPortal.ts:237`                                                                                                                                      |

**Two-engine consequence.** Every new business-table change needs a Postgres migration and a `Postgres*` twin (CLAUDE.md). The plan therefore keeps the Drive/backup catalogue in **new SQLite-only `motard_*` tables** (same convention as `0005`), and keeps the merge engine **out of** business-table schema. Smart Merge reuses existing repositories and invariants; it adds no business columns. Any change that does touch a business table is marked **[PG+SQLite]** and must follow CLAUDE.md.

---

## 1. Architecture overview

### 1.1 Component map

```
┌──────────────────────────── Desktop process (Tauri 2 / Rust shell) ─────────────────────────────┐
│  WebView (React SPA)                    Rust shell                                              │
│  ┌──────────────────────┐   IPC    ┌─────────────────────────────────────────────────────────┐  │
│  │ settings.drive.tsx   │─────────▶│ google.rs     OAuth: bundled client, loopback, tokens   │  │
│  │ settings.backup.tsx  │          │ archive_scheduler.rs  monthly timer + boot catch-up     │  │
│  │ archive-snapshot.tsx │◀─render──│ pdf_render.rs  WebView2 PrintToPdf / CapturePreview     │  │
│  │ (print HTML builders)│          │ commands.rs   file staging, save/pick, folder helpers   │  │
│  └──────────┬───────────┘          └───────────────┬─────────────────────────────────────────┘  │
│             │ invoke("api") HTTP-over-pipe         │ POST /api/desktop/runtime/drive-token       │
│             ▼                                      ▼ (existing, boot.rs:322)                    │
│  ┌──────────────────────────── Node backend (SQLite engine, named pipe) ────────────────────┐   │
│  │ routes/drive*.route.ts     → coordinator, queue, catalogue, merge                          │   │
│  │ googledrive/*              → DriveClient (files.list/update/get alt=media), folders, queue │   │
│  │ backup/*                   → createAndVerifyBackup (existing), restore (existing),         │   │
│  │                              mergeEngine (NEW), replay (NEW)                              │   │
│  │ SQLite: business tables + motard_drive_* + motard_backup_catalog (NEW)                    │   │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                   │ HTTPS (Drive v3 / upload v3)
                                                   ▼
                                  Google Drive:  [اسم الشركة] - أرشيف النظام/YYYY/YYYY-MM — …/<category>/
```

### 1.2 Data flow: monthly archive and manual "upload now"

```
 trigger (timer | boot catch-up | "رفع نسخة كاملة الآن")
        │
        ▼
 archive_scheduler.rs  ──(1) creates run row via backend POST /api/drive/archive/runs
        │                     kind = monthly | manual | catchup, period = YYYY-MM
        ▼
 backend  archiveBundle.ts  ──(2) enumerates the period's artifacts (ids + content hash only)
        │   invoices(sale|entry) · returns · statements(customer|supplier) · cashbox ledger
        │   + one VERIFIED backup ZIP (kind = data bundle)
        ▼
 for each artifact (sequential, lease-protected, see Phase 4):
        │   ┌─ needs PDF? ── yes ──▶ frontend renders HTML (print builders, same as printPortal)
        │   │                        └─▶ invoke("archive_render_pdf", html) → pdf_render.rs
        │   │                             WebView2 PrintToPdf → staging\<runId>\<name>.pdf  (sha256)
        │   └─ data bundle / CSV ──▶ backend builds bytes directly
        ▼
 backend  driveFiles.ts  ──(3) findByAppKey(folder, appKey)
                             ├─ found  → files.update uploadType=media  (UPSERT, same file id)
                             └─ absent → files.create uploadType=multipart|resumable
        ▼
 motard_drive_uploads row = done (+ drive_file_id, sha256)  →  motard_backup_catalog row (if bundle)
        ▼
 progress: GET /api/drive/archive/runs/:id  (polled every 1 s by settings.drive.tsx)
```

### 1.3 Data flow: browse, download and Smart Merge restore

```
 settings.drive.tsx  "استرجاع / دمج" on a catalogue row
        │  POST /api/drive/backups/:id/merge-plan        (dry run, Idempotency-Key not needed: no write)
        ▼
 backend  driveDownload.ts ─ files.get alt=media → staging\merge\<id>.zip (streamed)
        │                 ─ size + sha256 vs. catalogue appProperties → refuse on mismatch
        ▼
 openAndVerifyBackupV3()  (existing, sqliteBackup.ts)  → manifest, tables, row counts
        │
        ▼
 stageSnapshot()  (NEW) → isolated temp SQLite  ← copy of backup database.sqlite
        │
        ▼
 mergePlanner.ts  (NEW) compares live DB vs staged DB by primary key and document key
        │         → plan: insert N / update M / keep-live K / conflict C / refused R
        ▼
 settings.drive.tsx dialog shows the plan counts + conflicts; user confirms
        │  POST /api/drive/backups/:id/merge-apply   (financial → Idempotency-Key REQUIRED)
        ▼
 mergeApply.ts  (NEW, single SQLite transaction, all-or-nothing)
        │   1. safety backup (existing createAndVerifyBackup kind = pre-operation)
        │   2. insert missing rows (keep original ids)   3. apply conflict policy
        │   4. chronological replay → party balances, roll quantities, cashbox daily balances
        │   5. verify invariants (I-1…I-9, §3 Phase 5h) → COMMIT or ROLLBACK
        ▼
 motard_merge_runs row (audit)  →  invalidateFinancialViews on the client
```

### 1.4 Local archive and Drive archive share one naming engine

```
packages/shared/src/archivePaths.ts  (NEW, pure)
   companyFolderName(name)          → "<name> - أرشيف النظام"
   yearFolder(date)                 → "2026"
   monthFolder(date)                → "2026-10 — تشرين الأول"
   categoryFolder(cat)              → one of 6 fixed Arabic names
   documentFileName(meta)           → "2026-10-14_09-30_sale_INV-0042_<party>.pdf"
   appKey(meta)                     → stable key stored in Drive appProperties
        │
        ├── backend/googledrive/*  (Drive)
        └── desktop-app commands.rs + src/lib/archivePaths (local, Desktop\<company>\…)
```

---

## 2. Cross-cutting decisions (decide before Phase 1)

| ID   | Decision                              | Recommendation                                                                                                                                                                                                        | Why                                                                                                                                                                      |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Who owns the default OAuth client?    | A company-owned Google Cloud project; its client ID is compiled in from `release-identity.json` (CLAUDE mentions it; **[VERIFY]** the file and its fields). Advanced override stays under a collapsed "متقدم" section | Consumer UX needs zero setup. A "Desktop app" secret cannot be truly secret in a shipped binary; accept that and rely on Google's installed-app model                    |
| D-2  | Google app verification               | Submit for verification before wide release. Until then, testing mode limits test users                                                                                                                               | Unverified apps show a warning and cap users; this is a release gate, not a code task. **[VERIFY]** Drive scope classification in Google's current policy                |
| D-3  | Fallback when loopback is blocked     | Fallback = copy-the-code page (`urn:ietf:wg:oauth:2.0:oob` is deprecated). Preferred: a hosted redirect page on the company domain that shows the code for pasting                                                    | A plain fallback needs a small hosted page; the desktop cannot receive a redirect otherwise. **Owner decision**                                                          |
| D-4  | PDF engine                            | WebView2 `PrintToPdf` in the existing shell (no new runtime, reuses the print CSS and Arabic font CSS)                                                                                                                | Headless Chromium adds ~150 MB; pure-Node PDF libraries do not shape Arabic correctly without extra work. **Spike required in Phase 3** (see §3.3)                       |
| D-5  | Who triggers rendering                | The shell (Rust) triggers the monthly job, and the WebView renders HTML on request                                                                                                                                    | The backend runs headless with no window, so it cannot render HTML. Shell timer keeps the schedule working when the window is closed to tray **[VERIFY]** tray behaviour |
| D-6  | Document key for upsert               | Drive `appProperties.motardKey` = `appKey(meta)` (type + tenant + document id). Name is for humans only                                                                                                               | Renaming a party must not create a duplicate; an invoice number can be reused after deletion                                                                             |
| D-7  | Document number collisions in merge   | **Owner decision.** Recommended: match by UUID first; a same-number/different-UUID pair is imported under the backup's UUID and flagged for renumbering review, never silently merged                                 | Two devices can each issue `INV-0042`; `motard_sequences` / `document_number_block` exist to prevent this but offline devices can collide **[VERIFY]**                   |
| D-8  | Conflict rule for cancelled documents | Cancellation is monotonic: a `cancelled` state always wins over `active`, regardless of `version`/`updatedAt`                                                                                                         | Prevents a restore from resurrecting a cancelled invoice                                                                                                                 |
| D-9  | Wholesale replace                     | Keep as an advanced option behind a second confirmation; Smart Merge is the default                                                                                                                                   | Owner requirement                                                                                                                                                        |
| D-10 | Drive retention                       | Keep the newest 12 data-bundle ZIPs on Drive; never delete PDFs automatically                                                                                                                                         | A Drive delete is irreversible for the user; bundles are large                                                                                                           |

---

## 3. Phase-by-phase implementation

Each phase is independently buildable and testable. A phase must not change behaviour of an earlier phase's public contract. Phase order is fixed only where marked **depends on**.

### Phase 1 — Consumer connection UX & account status (no archive changes)

**Status: IMPLEMENTED (pending owner test).** Built as described below, with these deliberate deviations:

- **Bundled client source:** build-time environment variables `MOTARD_GOOGLE_CLIENT_ID` / `MOTARD_GOOGLE_CLIENT_SECRET` read with `option_env!` in `google.rs`, instead of `release-identity.json`. Reason: `release-identity.json` is committed to git, and a client secret must not be. `release-identity.json` only holds `tenantId` (verified).
- **Link binding:** the sealed store records `linked_client_id`. A link made with one client is treated as unlinked when the client changes (`google.rs` `link_matches`, `current_token`).
- **Backend contract unchanged:** `/api/drive/status` is not modified in Phase 1. The last-backup time comes from the existing `lastUpload.uploadedAt`.
- **Fallback (D-3)** deferred per owner decision. Loopback failure shows the existing error.
- **Folder rename** (Phase 2) not touched.

Files changed in Phase 1:

- `desktop-app/src-tauri/src/google.rs`: `ClientCreds`, `bundled_creds`, `resolve_client`, `link_matches`, `status` (adds `source`, email only when linked), `configure`, `connect_start`, `connect_finish`, `disconnect`, `current_token`, 3 new unit tests.
- `src/lib/drive-archive.ts`: `GoogleShellStatus.source`.
- `src/routes/settings.drive.tsx`: connect label "ربط حساب Google Drive", connected badge, "تم ربط حساب: …", "آخر نسخة احتياطية: …", "إلغاء الربط / تغيير الحساب", advanced client form in a `<details>` gated by `showAdvancedClientForm`.
- `src/lib/drive-account.ts` (new): pure view helpers. `src/lib/__tests__/drive-account.test.ts` (new, 9 tests).

Verification run: `cargo test -j1` 35/35; frontend `vitest run` 521/522 passing (one print test timed out under full-suite load and passes alone); `tsc` clean; root and backend `lint` 0 warnings; backend Drive tests 20/20 on rerun (one earlier run flaked in `drive-e2e`).

Not verified: a live Google consent flow; the rendered UI in the desktop app.

Original goal and design:
**Goal:** one-click connect with bundled client; account card; last-backup timestamp. Depends on nothing.

**1a. Bundled client (Rust)**

- `desktop-app/src-tauri/src/google.rs`:
  - `configure()` (line 247) keep; add `Google::effective_client(&self) -> Result<ClientCreds, String>`: uses stored override if present (advanced), else the compiled-in default from `release-identity.json` **[VERIFY field names]**.
  - `status()` (line 236-244): add `"source": "bundled" | "override" | null`, `"clientConfigured": bool`, `"scopes"` unchanged.
  - `connect_start()` (line 267-280): read `effective_client()` instead of `load().client_id` (line 268-270).
  - `current_token()` (line 334), `disconnect()` (line 318): use `effective_client()` for the refresh form (line 343-350, `client_secret` push at 348-350).
- `commands.rs` line 271-283: `google_status_cmd` / `google_connect_start_cmd` unchanged signatures; `google_configure_cmd` (line 276) is now advanced-only.
- `main.rs` handler list (lines 52-56): no new commands in this phase.

**1b. Loopback reliability and the success page**

- `google.rs:409-431` (`answer`): already returns "تم الربط" HTML. Add `window.close()` script and a 3 s auto-close note; keep the page self-contained (no network).
- Fallback (D-3): new `google.rs` method `connect_fallback_code()` returning a short code and a hosted URL. Implementation waits on D-3.
- New file: `desktop-app/src-tauri/src/google_fallback.rs` (only if D-3 chooses the hosted page).

**1c. Account profile**

- `google.rs:166-172`: email comes from `id_token`. Keep. Add a refresh-time email fallback via Drive `about` (`backend/src/infrastructure/googledrive/driveClient.ts:306-311`, already implemented as `ping()`), used only when `email` is null.
- No DB change; email lives in the sealed store (`Store.email`, `google.rs:57`).

**1d. Frontend**

- `src/routes/settings.drive.tsx`:
  - Lines 185-219 (client ID/secret form): wrap in a `<details>` titled "إعدادات متقدمة" and render only when `shellData.source === "override"` or the user opens it.
  - Lines 237-248 (connect button): label "ربط حساب Google Drive"; show `connecting` text at 250-255 unchanged.
  - Lines 176-183 (status line): replace with a status badge plus `تم ربط حساب: {email}`.
  - Lines 224-234 (test/disconnect): rename disconnect to "إلغاء الربط / تغيير الحساب"; keep `ConfirmDialog` 370-379.
- `src/lib/drive-archive.ts:88-98` (`googleConfigure`): unchanged, now advanced-only.
- New: `src/components/drive/AccountStatusCard.tsx` (badge, email, last backup `st.lastUpload.uploadedAt` from `driveApi_.status`, `drive-archive.ts:36`).

**1e. Tests**

- `desktop-app/src-tauri`: extend `full_link_flow_with_a_fake_google` (`google.rs:523-576`) to cover the bundled client path and `source` field.
- `src`: component test for the status card (email visible, disconnect confirm).

**Exit criteria:** a fresh install with no override connects in one click; the disconnect button reads correctly; no regression in `google.rs` unit tests.

---

### Phase 2 — Naming engine & folder hierarchy (local + Drive), with Drive upsert

**Status: IMPLEMENTED (pending owner test).** Deviations and known limits, recorded from the build:

- **Shared engine:** `packages/shared/src/archivePaths.ts` (+ 25 tests), exported from the shared index. The older print-name module `documentFilename.ts` is unchanged and still serves the print path.
- **Root rename (owner decision):** `FolderOrganizer.resolveRoot` renames the existing root folder in place (same Drive id, no files move) to `[company] - أرشيف النظام`. It reads any cached root row, whatever its old label, so a second company-name change also renames rather than duplicating. The company name comes from `installationStateRepo.findAnyCompleted()` → `companyRepo.findByTenant()`, read per pass (`server.ts`, `driveArchiveWiring.ts`).
- **Legacy section keys:** queue rows created before Phase 2 (`salesInvoices`, `dbBackups`, …) are mapped by `categoryOfSection` (`archiveCore.ts`) instead of throwing on every pass. The Drive archive shipped in 0005, so installed databases may hold these rows.
- **Upsert key limit (known, not fixed):** `documentKey` is built from the file's deterministic name (`entityId`), not the document UUID. An invoice whose party is renamed therefore gets a new name and a second Drive file. Matching by UUID needs the queue to carry the document id; that is deferred.
- **Upsert is tested with fakes only:** `findByAppKey`/`updateMedia` run against test doubles that return "not found". No test exercises an actual "found → updateMedia" path against a Drive-like server.
- **Local archive:** Desktop tree is now `<Desktop>\<company>\YYYY\YYYY-MM — month\<category>\`. Rust `ARCHIVE_CATEGORIES` mirrors the shared list; a test reads the TypeScript file and fails if they diverge. Print metadata carries the business month (`archiveMeta` → `period`).
- **Not verified:** a live Drive account; the rendered folder tree on a real desktop.

Verification: shared 25/25; Drive and SQLite-backup backend suites 100/100 (13 files, no PostgreSQL); Rust 38/38; frontend 547/547 (109 files); frontend and backend `tsc`, `typecheck:sqlite`, both lints, and prettier on changed files all clean. Backend full-suite failures are PostgreSQL-only parity suites that need a live server (`ECONNREFUSED 127.0.0.1:5432`), unrelated to this phase.

**Goal:** `[company] - أرشيف النظام / YYYY / YYYY-MM — month / category`; deterministic names; upsert instead of duplicate. Depends on Phase 1 only for the company name (already available via `tenants.name`).

**2a. Shared naming engine (new)**

- NEW `packages/shared/src/archivePaths.ts`: pure functions `companyFolderName`, `yearFolder`, `monthFolder`, `categoryFolder`, `documentFileName`, `appKey`, `sanitizeSegment` (copy the rule from `archiveCore.ts:91-99` and keep behaviour identical).
- Export it from the `@erp/shared` index **[VERIFY index file]**.
- NEW `packages/shared/src/archivePaths.test.ts`.

**2b. Category set (fixed, Arabic, requested)**
Replace the section catalogue in `archiveCore.ts:31-44`. Target categories and keys:

| key              | Arabic folder         | Content                              |
| ---------------- | --------------------- | ------------------------------------ |
| `entry_invoices` | فواتير الدخول         | entry invoices (PDF)                 |
| `sale_invoices`  | فواتير الخروج         | sale invoices (PDF)                  |
| `returns`        | المرتجعات             | return invoices (PDF)                |
| `statements`     | كشوف الحسابات         | customer & supplier statements (PDF) |
| `cashbox`        | الصندوق والتقارير     | cashbox ledger PDF + PNG snapshot    |
| `system_backups` | نسخ النظام الاحتياطية | data bundle ZIP for Smart Restore    |

Migration impact: `archiveCore.ts:31` `SECTIONS` keys change, so `motard_drive_folders` rows keyed by old labels (`folderOrganizer.ts:27-46`) become stale. Handle in 2d.

**2c. Filename rule**

- `documentFileName` produces `YYYY-MM-DD_HH-mm_<type>_<code>_<party>.pdf`. `HH-mm` comes from the document's `createdAt` (invoices `invoice.table.ts:33`, vouchers `voucher.table.ts:29`), **not** the render time, so the name is stable across re-renders.
- Maximum length: 150 characters, the same cap as `safeFileStem` (`backup.route.ts:692-695`).

**2d. Backend folder engine**

- `backend/src/infrastructure/googledrive/archiveCore.ts`:
  - Line 8 `DRIVE_ROOT_NAME`: replace constant with `driveRootName(companyName)` from `@erp/shared`. Keep the legacy root id: on first run, if a cache row exists for `kind=root, label=DRIVE_ROOT_NAME`, reuse it and rename the Drive folder to the new name (or keep it and record the new name — **owner decision**; recommended: rename).
  - Line 71-77 `monthFolderName`: delegate to `archivePaths.monthFolder` (same output for existing months).
  - Line 111-117 `archiveFileName`: delegate to `archivePaths.documentFileName`.
- `backend/src/infrastructure/googledrive/folderOrganizer.ts`:
  - `ensureChain` (lines 89-97): add a level `kind=company`? **No**: the company folder _is_ the root. Keep 4 levels: root → year → month → category. Category step uses new keys.
  - `resolve` (lines 68-86): unchanged; cache invalidation at line 74 already handles stale ids.
- `backend/src/infrastructure/googledrive/driveClient.ts`:
  - New `findByAppKey(parentId, appKey)` using `files.list` with `q = appProperties has { key='motardKey' and value='…' } and trashed = false` (new method after line 187).
  - New `updateMedia(fileId, mime, content)` = `PATCH /upload/drive/v3/files/{id}?uploadType=media` (new method after `uploadResumable`, ~line 265+).
- `backend/src/infrastructure/googledrive/uploadQueue.ts`:
  - `process` (lines 172-204): before `uploadSmall`/`uploadResumable` (lines 185-189), call `findByAppKey`; if found, `updateMedia` (same file id, no duplicate). Store `appProperties.motardKey` and `sha256` on create.
  - `uploadSmall` (`driveClient.ts:203-229`) and `uploadResumable` (`:236`) gain an `appProperties` argument.

**2e. Local archive**

- `desktop-app/src-tauri/src/commands.rs`:
  - `DOC_FOLDERS` (lines 131-137): replace with the 6 categories above.
  - `archive_root` (lines 148-151): becomes `<Desktop>\<companyFolderName>` (already company-based; keep).
  - `ensure_document_folders` (lines 153-160): create the 6 categories under `YYYY\YYYY-MM — month\`. It takes the period, so change the signature: `ensure_document_folders(company_name, period)`.
  - `archive_document_pdf` (lines 162-175): writes HTML today. Phase 3 replaces it with `archive_render_pdf` (new name, old command kept for one release).
- `src/components/print/printPortal.ts:249-269` (`archiveIfDesktop`): pass the period and category; use `archivePaths` (frontend copy in `src/lib/archivePaths.ts`, re-export of `@erp/shared`).

**2f. Tests**

- `packages/shared`: naming, sanitising, 150-char cap, Arabic month names for all 12 months, stable names across re-renders.
- Backend: `drive-upload-queue.test.ts` and `drive-archive-core.test.ts` (existing) must pass; add a test that re-enqueueing an edited invoice with the same `appKey` updates the existing Drive id (fake Drive server in `drive-client.test.ts`).

**Exit criteria:** two uploads of the same invoice with different content produce one Drive file. Renaming the company updates the root name without duplicating folders.

---

### Phase 3 — Real PDF engine: invoices, returns, statements, cashbox PDF & PNG

**Status: PARTIALLY IMPLEMENTED. The PDF and PNG rendering is NOT finished.** The parts below are built and tested; the WebView2 render calls are not.

**Built and tested:**

- **Pure page CSS** moved to `src/components/print/archivePageCss.ts` (no React or store imports). `printPortal.ts` re-exports it, so there is still one copy. The DFP-002 guard in `blankFirstPage.test.ts` now checks the import and call, not a literal string.
- **HTML builders** `src/components/print/archiveDocuments.ts`: invoice body (every roll line, totals, paid and remaining), statement body (ordered legs, running balance, cancelled legs print but do not move the balance), cashbox body (per-currency, never added across currencies), with HTML escaping and `round2dp` money. 19 tests in `__tests__/archiveDocuments.test.ts`.
- **Snapshot route** `src/routes/archive-snapshot.tsx`: hidden, fixed 1280px, reads the month through `useLedgerEntries({ fromDate, toDate, status: "all" }, { all: true })`. `routeTree.gen.ts` regenerated with the project's own generator; the diff adds only this route.
- **Change detection** `backend/src/infrastructure/googledrive/archiveBundle.ts`: canonical JSON, SHA-256 source hash, `decideRender` (new / changed / previous-failed → render, unchanged → skip). 10 tests.
- **Rust** `desktop-app/src-tauri/src/pdf_render.rs`: staging layout under `<root>\archive-staging\<runId>\`, run-id and file-name validation, paper sizes, SHA-256 from the staged bytes, clear-run. 6 tests. Registered commands `archive_render_pdf_cmd`, `archive_capture_png_cmd`, `archive_clear_run_cmd`; bridge functions in `tauri-bridge.ts`. `webview2-com` pinned to `=0.39.1` (the version tauri already links).

**NOT built (blocking the PDF output):**

- `webview2_render` in `pdf_render.rs` loads the HTML (`NavigateToString`) and then returns an explicit error for both `PrintToPdf` and `CapturePreview`. **No PDF or PNG is produced yet.** It is deliberately an error, not an empty file, so nothing can upload a fake document. The two calls need a real WebView2 runtime to verify (desktop spike).
- The renderer is not yet called from a run; `archiveBundle.ts` decides _whether_ to render but does not yet query the database or drive the uploads.
- Archive HTML is produced by the pure builders from data the snapshot route loads, but the invoice, return and statement _pages_ that read the live data for each document are not yet wired to the builders.

**Design change from the plan:** the plan had the builders reuse the React print components. Those components depend on hooks and stores, so the builders are pure string builders over the same data and print classes instead. Rendering the real components would need a static-render step in the snapshot route; that is not built.

**Known pre-existing failures (not from this phase):** the full backend run fails in 82 files, almost all PostgreSQL-only (`ECONNREFUSED 127.0.0.1:5432`). Non-PostgreSQL failures (accountant privileges, idempotency release, sync device trust, tenant pool stamp) are in modules this session did not change. `backup-restore-cycle.test.ts` once failed on a Windows temp-folder cleanup race (`ENOTEMPTY`) and passed on two reruns.

Verification: frontend `tsc` clean; frontend suite 110 files / 566 tests passing; backend `tsc` clean; backend Drive and SQLite-backup suites passing except the intermittent cleanup race; Rust 44 of 44, warning-free; lint 0 warnings on changed frontend files; prettier clean.

**Goal:** replace CSV/HTML with rendered PDFs; no `window.print()`.

**3a. Spike (blocking, 1–2 days, before any other 3x work)**

- Verify `WebviewWindow::with_webview` in Tauri 2 exposes the WebView2 controller; call `ICoreWebView2::PrintToPdf` and `CapturePreview` on a hidden window that loads the HTML from a `data:`/`blob:` source or a local file.
- Acceptance: Arabic RTL text shapes correctly, `@page` size matches A4/A5 (print.css:34), output page count correct, PNG at 2× device scale.
- **[VERIFY]** tauri and webview2 crate versions in `desktop-app/src-tauri/Cargo.toml`.
- Fallback if the spike fails: `printpdf` / `genpdf` with bundled Arabic font and a shaping crate (`rustybuzz`), which is more work for the same result.

**3b. Rust renderer (new)**

- NEW `desktop-app/src-tauri/src/pdf_render.rs`:
  - `pub async fn render_pdf(app, html: String, out: PathBuf, paper: PaperSpec) -> Result<RenderResult, String>` — hidden WebView, `PrintToPdf`, wait for `DOMContentLoaded` + fonts, write `out`, return `{path, sha256, sizeBytes, pages}`.
  - `pub async fn capture_png(app, html: String, out: PathBuf, width: u32) -> Result<RenderResult, String>`.
  - Both write to a staging directory `<root>\archive-staging\<runId>\` (path from `paths.rs`; **[VERIFY]** `Paths` struct) and never to the Desktop folder directly.
- `desktop-app/src-tauri/src/commands.rs`:
  - NEW `archive_render_pdf_cmd` and `archive_capture_png_cmd` (register in `main.rs:39-56`).
  - Old `archive_document_pdf` (line 163) kept for one release, then removed.

**3c. HTML builders (frontend, shared with print)**

- NEW `src/components/print/archiveDocuments.ts`: builds the full HTML for each document from the **same** data the print components use. Reuse `buildArchiveHtml` (`printPortal.ts:220-246`) and `ARCHIVE_ARABIC_FONT_CSS` (`:240`).
- Document builders:
  - Entry / sale invoice: header (company from `company_profiles` `name, taxNumber, commercialReg`, `company_profiles.ts:11-13`), party, date, number; line table from `invoice_lines` (`invoice-line.table.ts:9-21`): fabric, colour, roll no. (`rolls.rollNo`, `roll.table.ts:12`), kg (`quantityKg`), pieces, price/kg (`pricePerKg`), discount (`discountAmount`), note; totals from `invoices` (`subtotal, discount, tax, shipping, total, paid, currency`, `invoice.table.ts:18-23`).
  - Return: `return_lines` (`return-line.table.ts:6-17`) with `returns` header **[VERIFY `returns` schema, not read]**.
  - Statement (customer / supplier): from `IStatementRepository` (`backup.route.ts:14` import; implementation **[VERIFY]**), one statement per active party per month, opening balance + legs, statement order `date, created_at, document-rank, id` (CLAUDE.md "Statement order").
  - Cashbox ledger PDF: from `ledger_entries` (`ledger-entry.table.ts:6-33`) filtered by period, plus `cashbox_daily_balances` (`cashbox.table.ts:6-16`) for opening/closing per day; PNG snapshot from a dedicated route (3d).
- Money formatting: use `@erp/shared` money helpers only (CLAUDE.md "Money"); never `Math.round(x*100)/100`.

**3d. Cashbox snapshot route (new)**

- NEW `src/routes/archive-snapshot.tsx`: fixed-width (1280 px) read-only page rendering the cashbox summary for a given `period` and `currency`. Hidden from navigation. Used only by the renderer, so the live cashbox page layout does not affect the output.
- The renderer loads `…/archive-snapshot?period=YYYY-MM&currency=SYP` in the hidden WebView (requires the SPA route to be reachable from the shell; **[VERIFY]** how the shell serves the SPA in production, `desktop-app/build/web`, CLAUDE.md).

**3e. Backend orchestration**

- NEW `backend/src/infrastructure/googledrive/archiveBundle.ts`: `planPeriod(periodKey)` → returns artifact descriptors `{category, kind: "pdf"|"csv"|"zip"|"png", appKey, fileName, sourceHash}` **without** rendering. `sourceHash` = hash of the canonical source rows (so a PDF is re-rendered only when its source changed).
- Hash-first ensures unchanged documents are never re-rendered (consistent with the existing idempotency in `uploadQueue.ts:71-116`).
- Replaces the body of `monthFiles` (`monthlyArchiveJob.ts:78-87`) and the regenerate path (`:94-106`). `regenerate` now asks the **frontend/shell** for the PDF bytes via a runtime route (see §4.2) instead of re-exporting CSV.
- `exporters.ts`: `invoicesForPeriod` (`:76-108`) and `expensesForPeriod` (`:111-146`) remain as the CSV fallback and as the source for the statement and cashbox row sets.

**3f. Tests**

- Golden-file tests for each builder (HTML snapshot).
- Renderer: page count and Arabic glyph check on a 3-page invoice (automated in Rust `cargo test -j1`, CLAUDE.md commands).
- Money: totals re-summed from line rows equal header totals (extends `drive-exporters.test.ts:102-112`).

**Exit criteria:** an invoice archived from the desktop produces a PDF in `…\فواتير الخروج\` with the correct name, and the same invoice re-archived after an edit replaces the file in Drive (Phase 2).

---

### Phase 4 — Monthly scheduler, catch-up, and "رفع نسخة كاملة الآن"

**Goal:** monthly archive that survives the desktop being off at month end; instant manual upload with progress. Depends on Phases 2 and 3.

**4a. Run model (SQLite, new migration)**

- NEW migration `backend/src/infrastructure/orm/sqlite/migrations/0007_drive_archive_runs.sql` **[VERIFY next number: the migrations folder has 7 `.sql` files and `0006` is the last one seen]**:
  - `motard_drive_runs` (existing, `0005`): add `period_key TEXT`, `progress_done INTEGER DEFAULT 0`, `progress_total INTEGER DEFAULT 0`, `current_file TEXT`, `trigger TEXT` (`monthly|catchup|manual|connect`).
- Update Drizzle schema `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts` (`motardDriveRuns` at line 64) **[SQLite schema is generated: update the generator source or mark as generated-exception per `scripts/generate-sqlite-schema.mts`; VERIFY]**.
- No Postgres migration (SQLite-only convention, G20). State this in the PR.

**4b. Scheduler**

- NEW `desktop-app/src-tauri/src/archive_scheduler.rs`:
  - Timer: on start and every 30 min, compute whether the current period has a `monthly` run in state `done`. Run when `now` is on or after the last day of the month (local) **or** the previous month has no `done` monthly run (catch-up).
  - Single-flight: a `Mutex<bool>` on `Shared` (`boot.rs:56-81`) plus the backend's `passInFlight` (`monthlyArchiveJob.ts:108`).
  - Primary-device gate stays in the backend (`authorizeUploadDevice`, `monthlyArchiveJob.ts:125-126`); the shell does not decide primary status.
- Wire in `main.rs` next to `boot::start_drive_token_loop` (line 65): `archive_scheduler::start(shared.clone())`.
- Replace the 6-hour rescan (`monthlyArchiveJob.ts:36-37, 212-223`): keep the timer only as a fallback tick (every 6 h) that checks for catch-up; the monthly work runs once per period.

**4c. Backend routes (new)**

- NEW `backend/src/presentation/routes/drive-archive.route.ts`, mounted in `driveArchiveWiring.ts` next to `createDriveRouter` (line 54):
  - `POST /api/drive/archive/runs` body `{trigger, periodKey}` → `202 {runId}`. Primary-only (`refuseIfNotPrimary`, `drive.route.ts:48-65`). Requires `Idempotency-Key` (CLAUDE.md: financial POSTs; the archive is not financial, so a **soft** key header is accepted but optional — decide, recommended: required to make double-clicks harmless).
  - `GET /api/drive/archive/runs/:id` → `{state, progressDone, progressTotal, currentFile, errors[]}` (polled).
  - `POST /api/drive/archive/runs/:id/cancel`.
  - Keep `POST /api/drive/sync-now` (`drive.route.ts:141-150`) as an alias that starts a `manual` run for the current period.
- Runtime route for render results (shell → backend), beside `drive-token` in `desktopRuntime.route.ts:60-67`:
  - `POST /api/desktop/runtime/archive-artifact` body `{runId, artifactId, path, sha256, sizeBytes}` — accepts a staged file path only inside `archive-staging\<runId>\`, re-hashes it (same pattern as `receiveShellPath`, `backup.route.ts:184-231`), then enqueues the upload.

**4d. Manual button**

- `src/routes/settings.drive.tsx`: new prominent button "رفع نسخة كاملة الآن" near the status card (insert after line 300 region, next to "مزامنة الآن" at 291-300). Calls `POST /api/drive/archive/runs {trigger:"manual", periodKey: current}`, then polls the run every 1 s and renders `progressDone / progressTotal` and `currentFile` (new progress bar using existing `Progress` component pattern from `settings.backup.tsx:18`).
- Existing "مزامنة الآن" (`syncNow`, lines 122-127) is retired after one release.

**4e. Data bundle**

- The bundle is the **existing** VERIFIED automatic DB ZIP (`createAndVerifyBackup`, `sqliteBackup.ts:448`), plus a `bundle-manifest.json` (periodKey, artifact count, per-file sha256). The manifest is generated by `archiveBundle.ts` (Phase 3e).
- Stop reading the whole ZIP into memory: change `enqueueVerifiedBackupUpload` (`monthlyArchiveJob.ts:194-210`) and `regenerate` (`:94-106`) to stream from disk (`fs.createReadStream` + hash stream); `uploadResumable` (`driveClient.ts:236`) accepts a stream. **This is required before any backup above a few hundred MB is uploaded.**

**4f. Tests**

- Scheduler: unit-test the period decision function in Rust (`cargo test -j1`) for: month end, catch-up after 3 days offline, already done, manual trigger.
- Backend: `drive-monthly-job.test.ts` (existing) extended for run state transitions and progress counters.
- E2E (desktop, manual checklist since no e2e harness runs the shell): start run, observe progress, cancel, confirm Drive has exactly one file per artifact.

**Exit criteria:** closing the app on the 30th and opening it on the 2nd produces the monthly run once. Manual upload shows progress and results in Drive with no duplicates.

---

### Phase 5 — Browse, download, and Smart Merge restore

**Goal:** list the last 10 Drive backups, download and verify, merge non-destructively. Depends on Phase 4 (bundle and catalogue). The merge engine can be developed in parallel against a local ZIP (it only needs a staged file).

**5a. Backup catalogue (SQLite, same migration family)**

- NEW table in `0007_drive_archive_runs.sql` (or `0008_backup_catalog.sql`):
  ```sql
  CREATE TABLE motard_backup_catalog (
    id TEXT PRIMARY KEY,                -- uuid
    drive_file_id TEXT NOT NULL UNIQUE, -- Drive id of the ZIP
    run_id TEXT,                        -- motard_drive_runs.id that produced it
    trigger TEXT NOT NULL,              -- monthly | catchup | manual
    period_key TEXT NOT NULL,           -- YYYY-MM
    created_at TEXT NOT NULL,           -- ISO, UTC
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,               -- done | failed | partial
    last_error TEXT
  );
  CREATE INDEX motard_backup_catalog_created ON motard_backup_catalog(created_at DESC);
  ```
- Excluded from backups (add to `EXCLUDED_TABLES`, `sqliteBackup.ts:37-50`), consistent with `motard_drive_*`.
- The catalogue is rebuilt from Drive on connect (`files.list` in the `system_backups` folder, `appProperties` carry size/sha256/runId), so a new device can list backups before any local history exists.

**5b. Last-10 list**

- `GET /api/drive/backups?limit=10` → `[{id, createdAt, trigger, documentCount, sizeBytes, status, canRestore}]`, from `motard_backup_catalog` ordered by `created_at DESC`.
- Frontend: NEW `src/components/drive/BackupHistoryTable.tsx`; a table with: date/time (`fmtDate`, reuse `settings.drive.tsx:37-44`), type (Auto monthly / Manual / Catch-up), count, size (reuse `formatBytes`, `settings.backup.tsx:339-345` — move to `src/lib/format.ts`), status badge, action "استرجاع / دمج".

**5c. Download and integrity**

- NEW `backend/src/infrastructure/googledrive/driveDownload.ts`:
  - `downloadToFile(fileId, expectedSha256, expectedSize, outPath)` = `GET /drive/v3/files/{id}?alt=media`, streamed to `outPath + ".partial"`, hashed while streaming, renamed only on match.
  - Reuses `DriveClient.request` retry and `DriveAuthError` mapping (`driveClient.ts`).
- NEW route `POST /api/drive/backups/:id/download` → staged path under `<root>\archive-staging\merge\`.
- The staged file then goes through the **existing** `openAndVerifyBackupV3` (`sqliteBackup.ts:517`) which re-verifies the archive's own manifest.

**5d. Staging snapshot (isolated)**

- NEW `backend/src/infrastructure/backup/mergeStage.ts`: `stageSnapshot(zipPath) -> {dbPath, manifest, cleanup}`:
  - Extract `database.sqlite` to a temp file (use the same extraction as `restoreBackupV3`, `sqliteRestore.ts:229`; **[VERIFY]** helper name).
  - Open read-only (`better-sqlite3` `{readonly: true}`); never attach to the live DB file.
- Live database is never written during planning.

**5e. Merge planner (read-only)**

- NEW `backend/src/infrastructure/backup/merge/mergePlanner.ts`. For each business table, compare live vs staged by primary key and by the document key, and classify each row:
  - `insert`: present only in backup → copy with its **original id**.
  - `keep-live`: present only in live → untouched.
  - `same`: equal content hash (use `tableDigest`-style per-row hash, `sqliteBackup.ts:145-167`).
  - `update-from-backup`: both present, backup `version` > live `version` (or equal version and backup `updatedAt` > live). Applies D-8: cancelled always wins.
  - `keep-live (newer)`: both present, live newer.
  - `conflict`: both present, same `version` and `updatedAt`, different content → shown to the user.
  - `number-collision` (D-7): same `(tenant, type, number)`, different `id` → shown; default action import with backup UUID and flag for renumbering review.
- Table order for planning and apply (FK order): `parties` → `rolls` (and `fabrics`, `colors` first, **[VERIFY]** their tables) → `invoices` → `invoice_lines` → `returns` → `return_lines` → `vouchers` → `ledger_entries` → `stock_movements` → cashbox tables → `day_closes` / `manual_movements`.
- Output: `MergePlan {counts per table per class, conflicts[], numberCollisions[], replayRequired: true}`, persisted to `motard_merge_plans` (new table, `planId`, `expiresAt`, `backupId`) so the apply step uses the exact plan the user saw.

**5f. Merge applier (single transaction)**

- NEW `backend/src/infrastructure/backup/merge/mergeApply.ts`:
  1. Verify `planId` exists, not expired, and the live DB has not changed since planning: compare a live digest recorded in the plan (`tableDigest` over the affected tables) → refuse with `PLAN_STALE` if different.
  2. Safety backup: `createAndVerifyBackup({kind:"pre-operation"})` (existing `preOperationBackup.ts`, **[VERIFY]** API) **before** the transaction.
  3. `BEGIN IMMEDIATE`:
     - Insert `insert` rows with original ids (ids are UUIDs, so no remapping is needed for inserts).
     - Apply `update-from-backup` as an **update of the invoice/voucher header and its children** (lines replaced atomically by parent id). Ledger rows are **never updated**: they are inserted if absent, or their cancellation state is copied as a reversal row (DB triggers keep the ledger append-only, CLAUDE.md "Ledger is append-only").
     - Apply the user's conflict choices (default: keep live).
     - Run the replay (5g).
     - Check invariants (5h); any failure → `ROLLBACK`, return `MERGE_VERIFY_FAILED`.
  4. Write `motard_merge_runs` audit row (planId, backupId, counts, invariant results, actor).
- Endpoint: `POST /api/drive/backups/:id/merge-apply` with `planId`, `conflictChoices`, **Idempotency-Key required** (financial, CLAUDE.md). Admin-only (`rbac(["admin"])`, consistent with `drive.route.ts:45`).
- Wholesale replace remains `POST /api/backup/restore` (`backup.route.ts:613-640`) and is labelled "استبدال كامل (متقدم)" in the UI.

**5g. Chronological replay — REARCHITECTED (see docs/MERGE_ENGINE_DESIGN.md)**

**REPLACED.** The previous design proposed recomputing party balances, roll quantities from
`invoice_lines`/`return_lines`, and `cashbox_daily_balances.closing_balance` by incrementally
carrying forward from the first merged date. **This is incorrect and would corrupt data:**

- Party balances are **derived at read time** from `ledger_entries`; there is no cached column
  to replay (`party_balances` was dropped in `0038_drop_party_balances.sql`).
- `rolls.remaining_pieces` has **no audit trail** anywhere (`stock_movements` has no pieces
  column); it cannot be reconstructed from `invoice_lines`/`return_lines`.
- `cashbox_daily_balances.closing_balance` is a **stored cumulative series** maintained by DB
  triggers. Incrementally replaying it against the trigger-maintained series **double-counts**.
  The correct approach is `rebuildCashboxSeries` (`dyePurgeRepository.ts:390-445`): DELETE the
  affected series, then re-derive with `sum(daily_delta) OVER (PARTITION BY currency ORDER BY day)`.
- The ledger has **no natural key** other than `client_operation_id` (nullable). Re-inserting old
  legs without a deterministic identity **double-posts silently**.

**The corrected design:**

- **Party balances:** NOT replayed. Derived at read time from `ledger_entries`. I-1 is a cheap
  assertion, not a replay target (see `docs/MERGE_ENGINE_DESIGN.md` §2.1).
- **Rolls:** `remaining_kg` recomputed from `stock_movements.balance_after_kg`.
  `remaining_pieces` reconstructed from `stock_movements.pieces_delta` (new column, Task 4.5).
  Rolls are **never** directly updated — the domain refuses it (`SqliteRollRepository.ts:156-160`).
- **Cashbox:** Full series rebuild via `rebuildCashboxSeries`. The
  `cashbox_daily_ledger_ai` trigger is neutralized for the merge transaction via
  `motard_tx_state.allow_series_rebuild`.
- **Ledger:** Every merged row carries a deterministic `client_operation_id` so re-running a merge
  is idempotent. Ledger rows are **never updated** (append-only trigger enforced).
- **Closed periods:** Pre-apply refusal — any merged date intersecting a `day_closes` row or
  `closed` `financial_years` year is refused **before** any write (I-13).
- **`invoices.paid`:** Never replayed. I-3 is a diagnostic with tolerance, not a gate.

**See `docs/MERGE_ENGINE_DESIGN.md` for the complete invariant set (I-1…I-15) and apply procedure.**

**5h. Invariants (all must pass before COMMIT)** — REPLACED by I-1…I-15 in
`docs/MERGE_ENGINE_DESIGN.md` §4:

| #    | Invariant                                                                  | Scope                             | Gate?           |
| ---- | -------------------------------------------------------------------------- | --------------------------------- | --------------- |
| I-1  | Per party/currency, `SUM(active ledger legs)` = statement-reported balance | All merged periods                | Yes             |
| I-2  | Per invoice: `header.total` = `SUM(lines)` after discounts                 | Imported invoices                 | Yes             |
| I-3  | `\|invoices.paid − Σ applied vouchers\|` ≤ tolerance                       | Imported invoices                 | Diagnostic only |
| I-4  | `0 ≤ remaining_kg ≤ initial_kg`                                            | Touched rolls                     | Yes             |
| I-5  | `PRAGMA foreign_key_check` empty                                           | Whole DB                          | Yes             |
| I-6  | No cancelled document became active                                        | Imported docs                     | Yes             |
| I-7  | No duplicate ids; no duplicate `(tenant, type, number)` except D-7 flagged | All inserted rows                 | Yes             |
| I-8  | Cashbox series = rebuild from ledger + manual                              | Imported period + all dates after | Yes             |
| I-9  | `integrity_check = ok`                                                     | Whole DB                          | Yes             |
| I-10 | Per invoice per currency: `Σ(active legs)` = `header.total` ± 2dp          | Imported invoices                 | Yes             |
| I-11 | Per invoice: `Σ(stock_movements)` = `Σ(invoice_lines)` kg + pieces         | Imported invoices                 | Yes             |
| I-12 | `invoices.paid` diagnostic                                                 | Imported invoices                 | No (diagnostic) |
| I-13 | No imported row intersects `day_closes` or `closed financial_years`        | All imported dates                | Yes (pre-apply) |
| I-14 | Rebuilt cashbox = pre-merge series for all dates **after** merge window    | All dates after merge             | Yes             |
| I-15 | Per roll: `0 ≤ remaining_kg ≤ initial_kg` and `remaining_pieces ≥ 0`       | Touched rolls                     | Yes             |

**I-10 is the central double-entry invariant:** the previous plan had no check that an invoice
header agrees with its own ledger legs. I-10 is evaluated **per invoice, per currency** — aggregate
sums hide per-document errors.

**D-7 (renumbering)** — REPLACED. The previous plan flagged collisions "for review" after the fact,
but `UNIQUE(tenant_id, type, number)` rejects the insert during the transaction. The corrected
design: the planner detects `(tenant_id, type, number)` collisions **before** the apply, proposes a
new number, rewrites `number` and `reference_number` in the **staged copy** (never the live DB),
and records the mapping in the merge report for human review. See
`docs/MERGE_ENGINE_DESIGN.md` §3.3.

**5i. Frontend** — unchanged, implementation deferred to Stage 4 Task 4.11d.
**5j. Tests** — implementation deferred to Stage 4 Task 4.12.

---

## 4. Contracts

### 4.1 HTTP (backend, desktop SQLite, admin via `rbac(["admin"])`)

| Method & path                                        | Body / query                | Response                                                                     | Notes                                                      |
| ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| GET `/api/drive/status`                              | —                           | existing `DriveStatus` (`drive-archive.ts:28-44`) + `account:{email,source}` | extend `drive.route.ts:67-114`                             |
| POST `/api/drive/archive/runs`                       | `{trigger, periodKey}`      | `202 {runId}`                                                                | primary-only                                               |
| GET `/api/drive/archive/runs/:id`                    | —                           | `{state, progressDone, progressTotal, currentFile, errors[]}`                | polled 1 s                                                 |
| POST `/api/drive/archive/runs/:id/cancel`            | —                           | `{ok}`                                                                       |                                                            |
| GET `/api/drive/backups?limit=10`                    | —                           | `{items:[BackupRow]}`                                                        | from `motard_backup_catalog`                               |
| POST `/api/drive/backups/:id/download`               | —                           | `{stagedPath, sha256, sizeBytes}`                                            | integrity checked                                          |
| POST `/api/drive/backups/:id/merge-plan`             | —                           | `MergePlan` + `planId`                                                       | read-only                                                  |
| POST `/api/drive/backups/:id/merge-apply`            | `{planId, conflictChoices}` | `RestoreReport`-shaped `MergeReport`                                         | **Idempotency-Key required**; `PLAN_STALE` if live changed |
| POST `/api/drive/test`, `/api/drive/queue/:id/retry` | —                           | unchanged                                                                    | `drive.route.ts:117, 182`                                  |

`BackupRow`: `{id, createdAt, trigger, periodKey, documentCount, sizeBytes, status, canRestore}`.
`MergePlan`: `{planId, expiresAt, tables:[{table, insert, update, keepLive, same, conflict, numberCollision}], conflicts:[{table,id,reason,liveVersion,backupVersion}], replayRequired:true}`.

Error codes follow the existing `{code, message, statusCode}` contract (`backup.route.ts:253-276`). New codes: `PLAN_STALE` (409), `MERGE_VERIFY_FAILED` (422), `DRIVE_FILE_HASH_MISMATCH` (422), `NOT_PRIMARY_*` (403, existing).

### 4.2 Runtime route (shell → backend, runtime token)

- `POST /api/desktop/runtime/archive-artifact` body `{runId, artifactId, path, sha256, sizeBytes}`. Path must be inside `archive-staging\<runId>\`; the backend re-hashes the file (pattern of `receiveShellPath`, `backup.route.ts:184-231`). Rejects anything else with `BACKUP_FILE_HASH_MISMATCH` or a new `ARTIFACT_PATH_REFUSED`.

### 4.3 Tauri IPC (`src/infrastructure/tauri-bridge.ts`, `main.rs:39-56`)

| Command                                    | Input                           | Output                                           | New?                              |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------ | --------------------------------- |
| `google_status_cmd`                        | —                               | `{connected, configured, email, scopes, source}` | extend (`commands.rs:271`)        |
| `google_connect_start_cmd` / `_finish_cmd` | —                               | `{consentUrl,state}` / status                    | unchanged (`commands.rs:281-296`) |
| `google_disconnect_cmd`                    | —                               | status                                           | unchanged (`:299`)                |
| `archive_render_pdf_cmd`                   | `{html, outName, paper, runId}` | `{path, sha256, sizeBytes, pages}`               | NEW (Phase 3)                     |
| `archive_capture_png_cmd`                  | `{url, width, outName, runId}`  | `{path, sha256, sizeBytes}`                      | NEW (Phase 3)                     |
| `archive_scheduler_status_cmd`             | —                               | `{lastMonthlyRun, nextCheck}`                    | NEW (Phase 4)                     |
| `archive_document_pdf`                     | —                               | —                                                | DEPRECATED after one release      |

### 4.4 Shared types (`packages/shared/src/driveSchemas.ts`, NEW)

- Zod schemas for `RunTrigger`, `BackupRow`, `MergePlan`, `MergeReport`, `ArtifactRef`, `RenderResult`. Both the backend route validation and the frontend client import them, so the contract cannot drift.

---

## 5. Database changes (summary)

| Change                                                                                                          | Engine | Migration                                         | Notes                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- | --------------------------------------------------------------- |
| Add columns to `motard_drive_runs` (`period_key`, `progress_done`, `progress_total`, `current_file`, `trigger`) | SQLite | `0007_drive_archive_runs.sql` **[VERIFY number]** | Excluded from backup (`EXCLUDED_TABLES`)                        |
| New `motard_backup_catalog`                                                                                     | SQLite | same                                              | Excluded from backup                                            |
| New `motard_merge_plans` (`planId`, `backupId`, `digest`, `expiresAt`, `planJson`)                              | SQLite | same                                              | Excluded from backup                                            |
| New `motard_merge_runs` (audit)                                                                                 | SQLite | same                                              | Excluded from backup; **kept** after merge (audit must survive) |
| Business tables                                                                                                 | —      | none                                              | Merge uses existing columns (`version`, `updated_at`, `status`) |

Any future addition to a business table requires a `Postgres*` migration and twin (CLAUDE.md) and `npm run typecheck:sqlite`.

---

## 6. Exact file manifest

Legend: **M** = modify, **N** = new, **[L]** = line range confirmed by reading.

### 6.1 `desktop-app/src-tauri`

| File                       | Action | Lines / functions                                                                                                                                                                                                      |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/google.rs`            | M      | `Store` 48-58; `status()` 236-244; `configure()` 247-264; `connect_start()` 267-280; `connect_finish()` 287-315; `disconnect()` 318-330; `current_token()` 334-368; `answer()` 409-431 (success page + auto-close) [L] |
| `src/google_fallback.rs`   | N      | fallback pairing (only if D-3 = hosted page)                                                                                                                                                                           |
| `src/commands.rs`          | M      | `DOC_FOLDERS` 131-137; `archive_root` 148-151; `ensure_document_folders` 153-160 (signature change); `archive_document_pdf` 163-175 (deprecate); Google commands 270-308 [L]                                           |
| `src/pdf_render.rs`        | N      | `render_pdf`, `capture_png`, `RenderResult`, `PaperSpec`                                                                                                                                                               |
| `src/archive_scheduler.rs` | N      | `start`, `decide_period_run`, single-flight, catch-up                                                                                                                                                                  |
| `src/boot.rs`              | M      | `Shared` struct 56-81 (add scheduler state); `push_drive_token` 322-352; `start_drive_token_loop` 355 [L]                                                                                                              |
| `src/main.rs`              | M      | `generate_handler!` 39-56 (register new commands); setup, line 65 (start scheduler) [L]                                                                                                                                |
| `src/paths.rs`             | M      | add `archive_staging` directory **[VERIFY file name]**                                                                                                                                                                 |
| `Cargo.toml`               | M      | WebView2 bindings feature flags **[VERIFY after spike]**                                                                                                                                                               |
| `release-identity.json`    | M      | default Google OAuth client id **[VERIFY]**                                                                                                                                                                            |

### 6.2 `backend/`

| File                                                                            | Action | Lines / functions                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/googledrive/archiveCore.ts`                                 | M      | `DRIVE_ROOT_NAME` 8; `SECTIONS` 31-44; `SECTION_LIST` 56-63; `monthFolderName` 71-77; `archiveFileName` 111-117 [L]                                                                                           |
| `src/infrastructure/googledrive/folderOrganizer.ts`                             | M      | `ensureChain` 89-97; `resolve` 68-86 [L]                                                                                                                                                                      |
| `src/infrastructure/googledrive/driveClient.ts`                                 | M      | `findChild` 178-187; add `findByAppKey`, `updateMedia`; `uploadSmall` 203-229 and `uploadResumable` 236 accept `appProperties` and stream bodies [L]                                                          |
| `src/infrastructure/googledrive/driveDownload.ts`                               | N      | `downloadToFile` (alt=media, hashed, `.partial`)                                                                                                                                                              |
| `src/infrastructure/googledrive/driveAccount.ts`                                | N      | account email via `about` fallback                                                                                                                                                                            |
| `src/infrastructure/googledrive/archiveBundle.ts`                               | N      | `planPeriod`, bundle manifest, artifact descriptors                                                                                                                                                           |
| `src/infrastructure/googledrive/uploadQueue.ts`                                 | M      | `enqueue` 71-116; `process` 172-204 (upsert via appKey, lines 185-189) [L]                                                                                                                                    |
| `src/infrastructure/googledrive/monthlyArchiveJob.ts`                           | M      | `CATCHUP_MONTHS` 36; `TICK_MS` 37; `monthFiles` 78-87; `regenerate` 94-106; `runArchivePass` 116-191; `enqueueVerifiedBackupUpload` 194-210 (stream, not readFileSync); `startDriveArchiveWorker` 212-223 [L] |
| `src/infrastructure/googledrive/exporters.ts`                                   | M      | keep `invoicesForPeriod` 76-108 and `expensesForPeriod` 111-146 as fallback/source; `toCsv` 24-34 [L]                                                                                                         |
| `src/infrastructure/googledrive/archiveRuns.ts`                                 | N      | run state machine, progress counters                                                                                                                                                                          |
| `src/infrastructure/backup/backupCatalog.ts`                                    | N      | `motard_backup_catalog` access, Drive rebuild on connect                                                                                                                                                      |
| `src/infrastructure/backup/mergeStage.ts`                                       | N      | `stageSnapshot`                                                                                                                                                                                               |
| `src/infrastructure/backup/merge/mergePlanner.ts`                               | N      | per-row classification, `MergePlan`                                                                                                                                                                           |
| `src/infrastructure/backup/merge/mergeApply.ts`                                 | N      | transactional apply, verify, audit                                                                                                                                                                            |
| `src/infrastructure/backup/merge/replay.ts`                                     | N      | chronological replay                                                                                                                                                                                          |
| `src/infrastructure/backup/merge/invariants.ts`                                 | N      | I-1…I-9                                                                                                                                                                                                       |
| `src/infrastructure/backup/sqliteBackup.ts`                                     | M      | `EXCLUDED_TABLES` 37-50 (add 3 new motard tables); `createAndVerifyBackup` 448 (reuse for safety backup) [L]                                                                                                  |
| `src/infrastructure/backup/sqliteRestore.ts`                                    | M      | export extraction helper used by `mergeStage` (`restoreBackupV3` 229; `carryOverDeviceState` 107) [L] — no behaviour change                                                                                   |
| `src/infrastructure/backup/preOperationBackup.ts`                               | M      | confirm API for merge safety backup **[VERIFY]**                                                                                                                                                              |
| `src/infrastructure/orm/sqlite/migrations/0007_drive_archive_runs.sql`          | N      | runs columns, catalogue, plans, merge runs                                                                                                                                                                    |
| `src/infrastructure/orm/sqlite/migrations/meta/_journal.json` **[VERIFY path]** | M      | journal entry for 0007 (CLAUDE: journals kept in sync)                                                                                                                                                        |
| `src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts`                  | M      | `motardDriveRuns` 64 + new tables (generator exception **[VERIFY]**)                                                                                                                                          |
| `src/presentation/routes/drive.route.ts`                                        | M      | `refuseIfNotPrimary` 48-65; routes 67, 117, 141, 153, 182 [L]                                                                                                                                                 |
| `src/presentation/routes/drive-archive.route.ts`                                | N      | runs, backups, merge-plan, merge-apply endpoints                                                                                                                                                              |
| `src/presentation/routes/desktopRuntime.route.ts`                               | M      | add `archive-artifact` next to `drive-token` (60-67) [L]                                                                                                                                                      |
| `src/presentation/driveArchiveWiring.ts`                                        | M      | `wireDriveArchive` 20-64: mount new router (line 54), new deps [L]                                                                                                                                            |
| `src/presentation/routes/backup.route.ts`                                       | M      | keep `restore` 613-640 and `restore-path` 648-672 (wholesale, unchanged); `receiveShellPath` 184-231 reused [L]                                                                                               |
| `src/application/use-cases/sync/syncCoverage.ts`                                | M      | register new POST routes with an exemption or coverage entry (lines 211-237 show the pattern) [L]                                                                                                             |
| `src/presentation/server.ts`                                                    | M      | Drive wiring 586-605 (no change expected); schedulers 807-817 [L]                                                                                                                                             |
| `tests/drive-*.test.ts`, `tests/sqlite/drive-e2e.test.ts`                       | M      | extend per phase                                                                                                                                                                                              |
| `tests/sqlite/merge-*.test.ts`                                                  | N      | merge fixtures and property tests                                                                                                                                                                             |

### 6.3 `packages/shared/`

| File                        | Action                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `src/archivePaths.ts`       | N — naming engine (single source of truth)                                         |
| `src/archivePaths.test.ts`  | N                                                                                  |
| `src/driveSchemas.ts`       | N — zod contracts                                                                  |
| `src/precision.ts`          | M only if a helper is missing for replay (read first) [L: referenced by CLAUDE.md] |
| `src/index.ts` **[VERIFY]** | M — export new modules                                                             |

### 6.4 `src/`

| File                                          | Action | Lines / functions                                                                                                                                                                                        |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/settings.drive.tsx`               | M      | form 185-219 (advanced collapse); connect 237-248; status 176-183; actions 224-234; syncNow 122-127 (retire); designate 131-144 (keep); list 258-327; failed jobs 330-368; disconnect dialog 370-379 [L] |
| `src/routes/settings.backup.tsx`              | M      | keep 70-113 (full export), 116-158 (settings JSON); add "استبدال كامل (متقدم)" label on `FullRestoreCard` (289-295); `formatBytes` 339-345 move out [L]                                                  |
| `src/routes/archive-snapshot.tsx`             | N      | cashbox PNG render target                                                                                                                                                                                |
| `src/components/drive/AccountStatusCard.tsx`  | N      | Phase 1                                                                                                                                                                                                  |
| `src/components/drive/BackupHistoryTable.tsx` | N      | Phase 5                                                                                                                                                                                                  |
| `src/components/drive/ManualUploadButton.tsx` | N      | Phase 4 (progress polling)                                                                                                                                                                               |
| `src/components/drive/MergeRestoreDialog.tsx` | N      | Phase 5                                                                                                                                                                                                  |
| `src/components/print/archiveDocuments.ts`    | N      | HTML builders: invoice, return, statement, cashbox                                                                                                                                                       |
| `src/components/print/printPortal.ts`         | M      | `buildArchiveHtml` 220-246; `archiveIfDesktop` 249-269 (use render IPC, period, category); `window.print` 335 stays for interactive printing only [L]                                                    |
| `src/lib/drive-archive.ts`                    | M      | `driveApi_` 59-72 (add endpoints); `googleConfigure` 88-98 (advanced) [L]                                                                                                                                |
| `src/lib/drive-backups.ts`                    | N      | client for catalogue and merge                                                                                                                                                                           |
| `src/lib/archivePaths.ts`                     | N      | re-export of `@erp/shared/archivePaths`                                                                                                                                                                  |
| `src/lib/format.ts`                           | N      | `formatBytes` (moved from `settings.backup.tsx:339-345`)                                                                                                                                                 |
| `src/infrastructure/tauri-bridge.ts`          | M      | add `archiveRenderPdf`, `archiveCapturePng`, `archiveSchedulerStatus` next to `archiveDocumentPdf` (170-178) [L]                                                                                         |

---

## 7. Phase dependency graph

```
Phase 1 (connection UX) ───────────────────────────────┐
                                                       ├──▶ Phase 4 (scheduler + manual) ──▶ Phase 5 (catalogue, download, merge)
Phase 2 (naming + upsert) ──▶ Phase 3 (PDF engine) ────┘                ▲
                                                                        │
Phase 5 merge engine (planner/apply/replay) can start in parallel with Phase 3,
using a local backup ZIP; it only joins the Drive flow in Phase 5 itself.
```

Rules: each phase ships behind a flag (`DRIVE_ARCHIVE_V2` in backend config and a shell feature toggle) so Phase N can be disabled without touching Phase N−1.

---

## 8. Risks and mitigations

| Risk                                                               | Impact                           | Mitigation                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| WebView2 `PrintToPdf` not reachable from Tauri 2                   | Phase 3 blocked                  | Phase 3a spike first; fallback PDF crate with Arabic shaping                                                         |
| Merge resurrects or double-counts money                            | Financial loss                   | Single transaction; invariants I-1…I-9; `PLAN_STALE` guard; safety backup first; ledger never updated, only appended |
| Document-number collision across offline devices                   | Confusing duplicate numbers      | D-7 explicit owner decision; flagged, never silent                                                                   |
| Google verification delays or user cap                             | Consumer rollout blocked         | D-2 release gate; testing-mode user list                                                                             |
| Bundled client secret extraction                                   | Quota abuse                      | Quota is per client; monitor; rotate by release; document in D-1                                                     |
| Full ZIP read into memory (`monthlyArchiveJob.ts:94-106, 194-210`) | Out-of-memory on large companies | Phase 4e streaming before any large upload                                                                           |
| Duplicate Drive files from the old path during rollout             | Clutter                          | Phase 2 upsert; one-time reconcile job by `motardKey`                                                                |
| Renamed categories orphan folder cache rows                        | Files land in old folders        | Phase 2d: cache rebuild and an explicit mapping table                                                                |
| Shell timer not running while the window is closed                 | Missed month-end                 | D-5 tray behaviour **[VERIFY]**; catch-up on boot covers the gap                                                     |
| Chronological replay drifts from the live balance formula          | Silent wrong balances            | Replay reuses the same functions the live path uses **[VERIFY]**; property test merge(A,B)=merge(B,A)                |

---

## 9. Verification commands (per CLAUDE.md)

- Frontend: `npx vitest run`; `npx tsc --noEmit`; `npm run lint`; `npx prettier --check .`
- Backend (SQLite): `cd backend && DB_ENGINE=sqlite npx vitest run`; `cd backend && npx tsc --noEmit`; `cd backend && npm run typecheck:sqlite`; `cd backend && npm run lint`
- Backend (PostgreSQL) for any business-table change: `cd backend && DATABASE_URL=… npm test`
- Shell: `cd desktop-app/src-tauri && cargo test -j1` (needs `desktop-app/build/web`; `npm run stage`)
- Build: `npm run build`
- Never `vitest --reporter=basic`; read the summary line.

---

## 10. Owner decisions needed before Phase 1

1. **D-1** Company-owned Google Cloud project and default client ID.
2. **D-2** Google verification as a release gate.
3. **D-3** Loopback fallback: hosted redirect page vs. none.
4. **D-7** Document-number collision policy in merge.
5. **D-10** Drive retention for data bundles.
6. Root folder rename policy (rename vs. keep legacy name) — §3 Phase 2d.
7. Whether the archive-run endpoint requires `Idempotency-Key` (§4.1).

## 11. Open verification items (must be closed in the first task of the phase)

- `release-identity.json` field names (Phase 1).
- Tauri 2 / WebView2 crate versions and PrintToPdf reachability (Phase 3a spike).
- Migration numbering and journal path (`0006` was the last file seen).
- `returns`, `parties`, `stock_movements`, `fabrics`, `colors` schemas, and the `IStatementRepository` implementation (Phases 3b, 5e, 5g).
- Whether any party balance or roll quantity is a cached column or always derived (Phase 5g). This decides the whole replay design.
- `preOperationBackup.ts` API and the SQLite archive extraction helper (Phase 5d).
- Tray behaviour when the window is closed (Phase 4b).
- `packages/shared` index file (Phase 2a).
