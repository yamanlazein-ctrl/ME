# CODEBASE_AUDIT_PROGRESS.md — Ultra-Deep ERP Audit (Session 2026-10-12, Hermes)

Checkpoint for the repository-wide, page-by-page ERP audit of `Motard Fabrics Group ERP`
(mission: "ULTRA-DEEP, REPOSITORY-WIDE ERP AUDIT"). Read-only first pass; the only permitted
writes are this file, `CODEBASE_AUDIT_FINDINGS.json`, and an appended session section in
`CODEBASE_AUDIT_REPORT.md`.

## Repository identity (Phase 0 — COMPLETE)

| Item | Value |
|---|---|
| Repository root | `C:/Users/Taw/Downloads/Compressed/q/ME-main` |
| Branch | `main` |
| HEAD audited | `a3882558a696a1a0de8d930bf49db408504147a8` (Merge remote-tracking branch 'origin/main', 2026-10-12) |
| Working tree | CLEAN (0 modified, 0 staged, 0 untracked) — verified twice, 45 s apart (no active writer on audit artifacts) |
| Recent commits | `7eaabec1` (audit reports/tests/CI sync), `762f2209` (PR #34 whole-repo quality audit), `4f3ae796` (audit report w/ 31 findings), `2b9b602c` (audit fixes sync) |
| Engines | PostgreSQL (`Postgres*` repos — web/hub) + SQLite (`repositories/sqlite/Sqlite*` twins — desktop); desktop = Tauri v2 shell + bundled Node sidecar on named pipe |
| Frontend | React + TanStack Router/Start, Vite, React Query; 50 route files, 191 tsx + 312 ts under `src/` |
| Backend | Express; 53 route files, 506 ts under `backend/src/`; tests: 185 backend / 88 frontend / 57 e2e / 10 desktop-script |
| Desktop shell | Tauri (Rust) — 21 rs files; installer `Motard Fabrics Group ERP_2.0.4_x64-setup.exe` = 31,583,131 bytes |
| Prior audits (LEADS, not proof) | `CODEBASE_AUDIT_REPORT.md` (5.7 MB; 31 findings H/M/L + S), `CODEBASE_REMEDIATION_LOG.md`, `CODEBASE_AUDIT_FINDINGS_hermes.json` (16 findings F-001..F-016), `MOTARD_ERP_FULL_FORENSIC_AUDIT.md`, `MOTARD_ERP_VERIFIED_FIXES.md`, `TESTING_SETUP_REPORT.md` |

## Phase 1 inventory (COMPLETE)

- Routes inventoried: 50 / 50 (src/routes, excluding `__tests__`).
- Backend route files inventoried: 53 / 53 (backend/src/presentation/routes).
- Migrations: SQLite `orm/sqlite/migrations` (0000_baseline + 0001..0004) and PostgreSQL `orm/migrations` (~99 + journal meta).
- Test infra: root `vitest` (88 files), backend `vitest` on SQLite/PostgreSQL (185 files), Playwright e2e (57), desktop script gates (10 `.test.mjs`), CI = `.github/workflows/ci.yml`.
- Environments available: repo (full), desktop build tree (target/release, target/dev-fast), owner live DB at `%LOCALAPPDATA%\motard-erp` (READ-ONLY reference; never a test target).
- External services NOT verifiable here: Render hub (PostgreSQL web/hub), Google Drive archive, update endpoint.

## Deep-audit dispatch (Phases 2–5) — 5/7 COMPLETE (4 taken over after subagent rate-limit failures)

7 parallel read-only subagents (`deleg_82e9d080`). The model's fair-share rate limit (HTTP 429)
killed 5 of them at 477–663s each; the areas were completed DIRECTLY by this auditor
(each JSON in `C:/Users/Taw/AppData/Local/hermes/cache/scratch/erp-audit-2026-10-12/`):

| Area | How completed | Output file | Result summary |
|---|---|---|---|
| FE-PAGES | direct (subagent died 477s) | `fe-pages.json` | 50 routes; 8 deep + pattern-level all; PartyDeleteDialog fully rebuilt (pagination/search/type-to-confirm/exact counts) — the Oct-10 requirement is DONE; all financial hooks invalidate; toast rule holds; submit guards hold |
| BE-API | **subagent ALIVE (task-1, active 16:17)** | `be-api.json` | pending delivery |
| DB-MIG | direct (subagent died 477s) | `db-mig.json` | 103 PG + 6 SQLite migrations; pgRef bookkeeping drift (Low); settings.drive parity VERIFIED via live-DB check + SS-01 test run (4/4) — avoided a false Critical; RLS coverage complete (48 tables); migration hygiene clean |
| SEC | direct (subagent died 656s) | `sec.json` | ALL checks hold: NOBYPASSRLS+FORCE RLS, tenant filters complete, idempotency on 13 route files, path-traversal hardening (F-014), pino redaction, JWT env-required, argon2id PINs, SEC-01 local-caller; only finding: rate-limit on auth only (Informational) |
| SYNC | **subagent ALIVE (task-4, active 16:17)** | `sync.json` | pending delivery |
| DESKTOP | direct (subagent died 663s) | `desktop.json` | ALL checks hold: VACUUM INTO atomic backups + .partial→rename + verify; restore refuses newer journal; uninstall preserves data (by design); exclusive data lock + Job-Object process-tree kill; SQLite-only (no port); IPC ACL gate 24/24 |
| STATIC-TESTS | direct (subagent died 477s; it had finished 6/10 commands) | `static-tests.json` | tsc×3 exit 0; lint root 0 errors/50 warnings (AT the limit); backend lint 0; port-drift: 46 twins; desktop gates 24/24 (server-bundle BLOCKED by EADDRINUSE 8080 — environmental); root vitest 93 files/410 tests PASS; backend sqlite vitest 958 pass/42 skip PASS; **prettier --check . FAILS: 100 files (92 source + 8 docs)** |

## Findings recorded so far (this session, before subagent results)

- **F-NEW-01 (Confirmed, Medium)** — *Shipped installer lags HEAD by ~3 days.*
  Evidence: `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.4_x64-setup.exe`
  (mtime 2026-10-09 20:56) embeds resources staged 2026-10-09 20:50 (`resources/server/server.mjs`,
  `resources/server/web/index.html`), while HEAD `a3882558` includes ≥4 later commits (2026-10-11 →
  10-12: audit-remediation sync `2b9b602c`/`7eaabec1`, quality-audit PR `762f2209`/`4f3ae796`).
  Impact: the desktop app the owner runs does NOT contain the Oct 10–12 fixes; answers the standing
  question "does the desktop run the latest code" = **no**.
- **F-NEW-02 (Confirmed, Low)** — *Build-tree bloat.* `target/release` ≈ 2.0 GB and `target/dev-fast`
  ≈ 2.2 GB; `bundle/` keeps ≥5 superseded installers (`nsis-old-2.0.1/`, `nsis-previous/`,
  `nsis-previous-2026-10-05-1200/`, `nsis-previous-2026-10-09/`). Not a runtime defect; slows builds
  and confuses "which artifact is current".
- **V-01 (Verified — prior root causes HOLD)** — The 2026-10-10 delete-OCC fixes are present in BOTH
  the current source and the shipped 2.0.4 bundle: `partyUseCases.ts:158` (`status === "cancelled"`
  idempotency) + `server.mjs` contains `current.status === "cancelled"` ×3; `BaseHttpClient.ts:83,138`
  (`replaySafe` guard) + minified web chunk `container-p7dRIUTU.js` contains
  `a=e.method===\`GET\`||!!r` … `if(r.code!==\`NETWORK\`||!a||o===t.maxRetries)throw r`.

## Blocked / not run (this session so far)

- `cargo test` (Rust) — compile-heavy; not attempted (no test-profile cache verified).
- Playwright e2e / agentic — needs disposable PostgreSQL + `E2E_ADMIN_PASSWORD`; not run.
- PostgreSQL-engine backend tests — need a disposable `erp_test` DB; not run (SQLite engine used instead).
- Owner live DB (`%LOCALAPPDATA%\motard-erp`) — READ-ONLY by rule; never a test target.

## STATUS: COMPLETE (2026-10-12 session)

All 7 areas completed (5 subagents + this auditor directly after HTTP-429 rate-limit failures; every dead subagent's transcript leads were mined). Aggregated: `CODEBASE_AUDIT_FINDINGS.json` (11 findings: 0 Critical, 0 High, 5 Medium, 1 Low, 5 Informational; 28 prior findings re-verified — the important ones all HOLD or are FIXED/RESOLVED). Session section appended to `CODEBASE_AUDIT_REPORT.md`. Verdict: AMBER.

Next exact starting point (if continued): the 5 Medium remediations in the report's S.5 — first rebuild the installer from HEAD, then review the 46 drifted twins, then the CI prettier gate.
