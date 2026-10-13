# ADR-001 — Motard ERP desktop application (v3, clean rebuild)

Status: accepted (2026-10-13). This replaces the retired `desktop/` shell (deleted; it is still in git
history at `a3882558`). None of its code was reused. The specifications that carry over are the
backend's own contracts (`specs/001-desktop-sqlite-engine/contracts/*`, `backend/src/infrastructure/config/env.ts`).

## Problem

The retired Windows build lost data on updates and re-installs. Program files, the database, keys
and backups were not separated clearly enough, and several startup paths could open a new, empty
database instead of the customer's.

## Decision

**Technology: Tauri 2 (Rust shell + system WebView2) around the existing ERP.**
- The ERP itself is unchanged and reused as-is: the React/Arabic UI (`src/`), and the Express backend
  with its SQLite engine (`backend/`). No business logic is duplicated in the shell.
- Why Tauri: the toolchain and crates are already on the build machine, installers are small
  (WebView2 ships with Windows 10/11), the backend stays a separate Node process (no ABI rebuild of
  native modules for an embedded runtime), and Rust gives direct access to DPAPI, Job Objects and
  named pipes.

### Fixed, separated locations

| What | Where | Touched by install / update / uninstall? |
|---|---|---|
| Program files (shell, Node runtime, backend bundle, UI) | `%LOCALAPPDATA%\Motard ERP\` (per-user NSIS; note the space — the data root below has none) | **replaced** on update; removed on uninstall |
| **Customer data root** | `%LOCALAPPDATA%\MotardERP\` (`MotardERP-Dev` for debug builds) | **never** |
| Database | `<root>\data\motard.db` (+ `-wal`, `-shm`) | never |
| Keys | `<root>\keys\secrets.dat` + `secrets.dat.bak` (DPAPI, current user) | never |
| Backups | `<root>\backups\` (verified v3 archives, pre-migration snapshots); `<root>\backups\pre-update\` (shell copies made before a new version first opens the data); mirror in `Documents\` (backend) | never |
| Identity / state | `<root>\install.json`, `<root>\state\` (db-meta, integrity manifest), `<root>\sync\` (hub url, session, credentials) | never |
| Logs | `<root>\logs\` (`shell.log`, `server.log`) | never |
| WebView cache | `%LOCALAPPDATA%\com.motardfabrics.erp3\` | uninstaller option only (no customer data there) |

**A new version only replaces program files.** The data root is outside the install directory, so no
installer step can delete or replace it.

### Startup sequence (`src-tauri/src/boot.rs`)

1. Single instance (a second launch focuses the window), then an exclusive lock on `<root>\motard.lock`.
2. Keys (`keys.rs`), with **no silent regeneration**:
   - the primary file decrypts → use it (repair `.bak` if needed);
   - primary bad, `.bak` good → use `.bak` and rewrite the primary;
   - nothing at all **and** no database, no `install.json` → first install: create both files;
   - otherwise (keys missing or unreadable while data exists) → **stop**, show the recovery screen,
     leave the files untouched. A new key set only comes from an explicit, typed "reset keys" action.
     It moves the old files aside, never deletes them. Business data is not encrypted with these keys;
     a reset costs sessions, hub credentials and the Google link only.
3. State (`state.rs`):
   - no database and nothing ever created → `FRESH` (mint `installationId` + `dataId`, mark
     `creating`);
   - database present → `REUSE`;
   - `install.json` says the data existed but the database is gone → **`DATA_MISSING`**
     (restore / start new). Never an empty start.
4. **New version on existing data** → before the new backend opens the database, the shell copies
   `motard.db` (+ WAL/SHM) to `backups\pre-update\<old>-to-<new>-<time>\` and verifies the sha256 of
   each file. If the copy fails, the new version does not open the data. The backend then makes its own
   verified pre-migration snapshot and migrates forward in transactions. **It never creates a new
   database over existing data** (`FRESH` only on an empty data root).
5. Spawn the backend (`backend.rs`): bundled `node.exe` + `server.mjs` with the env contract, in a
   Windows Job Object (it dies with the shell). The API is served on a **named pipe** unique to this
   launch; no TCP port.
6. Health = `GET /api/health/live` over the pipe. A boot failure is parsed from
   `[FATAL] Server startup failed: <reason>`. Codes `DATA_ID_MISMATCH`, `SCHEMA_TOO_NEW`,
   `INTEGRITY_FAILED`, `DATABASE_MISSING`, migration errors and others become recovery-screen states.
   No retry silently reaches another database.
7. After the first healthy boot: `install.json.lastAppVersion` and `dataId` are updated from the
   backend's `db-meta.json`.

### Recovery and rollback

- **Recovery screen** (`pages/boot.html` + `boot.js`, Arabic; the same page that shows boot progress): state, explanation, details, actions. Destructive actions need a typed phrase, checked again in Rust.
- **Failed update** (migration refused, schema too new, …): "restore the pre-update copy" moves the
  current files aside (`set-aside\<time>\`) and puts the pre-update copy back. The previous version
  can then be reinstalled and opens it unchanged.
- **Restore a backup:** pick a v3 archive → the current data moves aside → the backend boots `FRESH`
  with `MOTARD_RESTORE_ARCHIVE` (verified, staged restore) → `install.json` takes the restored
  `dataId`.
- **Start a new company / factory reset:** moves the data aside, never deletes it. Keys are kept.

### Communication

UI → `invoke("api")` (Tauri IPC) → Rust HTTP/1.1 over the named pipe → the same Express app. The
pipe is the "local desktop caller" boundary. Runtime-only backend calls (graceful shutdown, Drive
token) carry `X-Motard-Runtime-Token = sha256(APP_MASTER_KEY)`, which the UI never sees.

### Shutdown, Windows restart, crash

- Window close → `POST /api/desktop/runtime/shutdown` (in-flight writes finish, WAL checkpoint, close)
  → wait up to 15 s → kill.
- Shell crash / Windows shutdown → the Job Object kills the backend. SQLite WAL is crash-safe, and the
  next boot runs `integrity_check` on `REUSE`.
- Three backend crashes within 5 minutes → `SERVICE_STOPPED` (recovery screen); no restart loop.

### Updates

An update = run the new installer. Same identifier, per-user, so it replaces program files only.
There is no network auto-updater in v3.0: there is no update server under our control, and an unsigned
or unhosted update channel is worse than none. The UI says so (`check_desktop_update` → not available).

### Secrets never leak

- The shell logs codes and paths, never key material, tokens or request bodies.
- `secrets.dat` is DPAPI-bound to the Windows user. Backups exclude secrets (backend v3 format).
  Exports never contain keys.

### Licensing and device identity

- First-run seed: `server/desktop-seed.json`, built by `backend/src/scripts/build-desktop-seed.ts`
  with the licence signing key at build time. It holds the default tenant and a signed licence, no
  users and no business data, so the customer starts clean.
- Device fingerprint = sha256 of `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` with a product
  prefix (`get_fingerprint`). `installationId` lives in `install.json`.

### Reused vs removed

- **Reused unchanged:** UI, backend, SQLite engine and migrations, backup v3, sync, licensing, seed
  builder, the bridge contract in `src/infrastructure/tauri-bridge.ts` (same command names, new
  implementation).
- **Removed:**
  - the old Rust shell and its updater keys/feeds;
  - the NSIS hooks and HKCU install-instance marker (re-install now always reopens the same data —
    the documented rule);
  - the PostgreSQL desktop runtime remnants;
  - the old packaging scripts and their tests;
  - the SSR splash/recovery pages.
- **Not in v3.0 (documented, visible in the UI):** Google Drive OAuth in the shell — the Drive card
  reports "not available in this version"; local backups and the Documents mirror remain. Archived
  documents are saved as HTML (the printable page itself), not PDF.
