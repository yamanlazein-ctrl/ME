# Final remediation log: desktop rebuild (2026-10-13)

Everything below is uncommitted on `main` (base `a3882558`). Nothing was committed, pushed or deployed.

## Removed (owner-approved)

- The retired `desktop/` shell; it remains in git history at `a3882558`.
- `%LOCALAPPDATA%\motard-erp` and `motard-erp-dev` (test data only).
- `%USERPROFILE%\MotardRelease-Safety\`.

Kept before deletion:
- the licence verification public key → `desktop-app/src-tauri/resources/license-public.pem`;
- the PostgreSQL test binaries → `tools/postgres-test/` (git-ignored).

## New: `desktop-app/` (Tauri 2 shell; design in `desktop-app/ADR.md`)

| File | What it does |
|---|---|
| `src/paths.rs` | Fixed data root `%LOCALAPPDATA%\MotardERP` (`-Dev` for debug builds, `MOTARD_DATA_ROOT` for tests), separate from program files |
| `src/keys.rs` | DPAPI secrets with a `.bak` copy. Repairs one damaged copy from the other. **Never regenerates next to existing data**; reset is an explicit typed action that moves the old files aside. `Debug` output is redacted |
| `src/state.rs` | Startup decision: FRESH only on an empty root, a first boot that never finished keeps its ids, DATA_MISSING otherwise. Identity can be recovered from db-meta. Verified pre-update copy, rollback, move-aside |
| `src/backend.rs` | `node.exe` + bundle with a cleared, whitelisted environment, in a kill-on-close Job Object, no console window. stderr goes to `server.log`; boot failure reasons map to recovery states |
| `src/pipe.rs` | HTTP/1.1 over a per-launch named pipe (chunked bodies, busy retry, header injection filtered) |
| `src/boot.rs` | The sequence: lock → keys → decision → pre-update copy → spawn → health. Then supervision (3 crashes in 5 min → stop), graceful shutdown, recovery actions |
| `src/commands.rs` | The IPC surface the existing UI already calls. The runtime token is stripped from page requests. Backup save/pick are verified by sha256 and the save source is restricted to `backups\` |
| `pages/boot.html`, `boot.js` | Arabic boot progress and recovery screen |
| `scripts/stage.mjs` | Builds the UI, the backend bundle, the signed first-run seed (with gates) and the Node 22.14.0 runtime (sha256 checked against nodejs.org). Fails on `.env` files or private-key material |
| `release-identity.json` | The customer's tenant id; must stay fixed across releases |

## Defects found by the lifecycle tests and fixed

1. **Pre-update copy always failed on Windows.** `copy_verified` called `sync_all()` on a read-only
   handle (`FlushFileBuffers` needs write access → "Access is denied"). Found by `cargo test`. Fixed,
   and covered by two tests.
2. **Closing the app before setup was finished skipped the graceful shutdown.** The install gate
   answered `503 SETUP_REQUIRED` to `/api/desktop/runtime/shutdown`, so the WAL was not checkpointed.
   The runtime routes are now exempt; they authenticate with the runtime token themselves.
   Test: `backend/tests/install-gate-runtime-exempt.test.ts`.
3. **A migration that fails at import time showed only "exit code 1".** That error happens before
   the backend's `[FATAL]` handler exists. The shell now keeps the `…Error:` line and tags it
   `MIGRATION_FAILED` when the stack runs through `applyMigration`, and the recovery screen explains
   it. Test: `an_import_time_migration_error_is_captured_without_a_fatal_line`.
4. **Staging tooling:**
   - `tar` resolved to Git's GNU tar, which read `C:` as a host; the script now uses
     `System32\tar.exe`;
   - the seed builder needs a `SQLITE_PATH` for the config schema; it now gets a temp path.

## Permissions

Invitation codes are now created by the admin only, as the mission requires; this supersedes the
2026-10-12 note.
- `invitation.route.ts` answers `403 ADMIN_ONLY` for any non-admin, for every type and role.
- `settings.users.tsx` hides `InvitationManager` for non-admins.
- `accountant-admin-privileges.test.ts` asserts the use case is never called for the accountant.

## Repo housekeeping

- CI: the retired `desktop/scripts` gates were removed; the `desktop-windows` job now runs
  `desktop-app` `cargo test`.
- `eslint.config.js` and `knip.json` now ignore `desktop-app/**`.
- `CLAUDE.md` updated: layout, commands, PostgreSQL binaries path, customer data root.

## Process notes (stated plainly)

- During the live rollback test I drove the mouse with synthetic clicks. The second click landed on
  the owner's browser window, which had come to the front, in a blank area of an open page. Nothing
  appears to have been triggered. I stopped GUI automation at that point.
- On the first FRESH run, the "killed after 15 s" fallback log line did not appear after the 503. The
  root cause (defect 2) is fixed and every later shutdown logged `backend stopped cleanly`. The
  forced-kill path itself was not observed live; the Job Object guarantees the backend ends with the
  shell.
- The test installs were removed afterwards (uninstall entry and program folder are gone). The real
  customer data root `%LOCALAPPDATA%\MotardERP` was never created on this machine.
