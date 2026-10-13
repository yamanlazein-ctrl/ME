# Customer release readiness: Motard ERP desktop 3.0.0 (2026-10-13)

## Verdict

**Ready for a supervised first delivery. Not yet ready for unattended mass rollout.**

The data-safety lifecycle the old build failed at (install, update, re-install, crash) now works. It
was proven on this machine with the real installer, against isolated data folders. Three things are
still open, and none of them can be done on this machine:

- a clean-VM run;
- a real Windows restart;
- a code-signing certificate.

Do these before handing the installer to the customer without supervision.

## The deliverable

| Item | Value |
|---|---|
| Installer | `desktop-app/src-tauri/target/release/bundle/nsis/Motard ERP_3.0.0_x64-setup.exe` |
| Size | 27.33 MiB |
| Installer SHA-256 | `49B6E6E93DA99CF4708FDC0BC3B3557C2D51D3DC1F9587DB34103C1F8A2BCB1B` |
| App identifier | `com.motardfabrics.erp3` (new; the retired 2.x line used another one) |
| Install type | Per-user NSIS, Arabic and English. WebView2 bootstrapper is embedded. Unsigned. |
| Customer tenant id | `a8fe3d6f-806f-4a8c-8bfa-c200e99956ab` (`desktop-app/release-identity.json`) |

**The tenant id must stay the same for every future release of this customer's build.** Commit
`release-identity.json` and never regenerate it.

## Clean slate

On a fresh data root the database holds no business data:

- 0 users, 0 customers/suppliers, 0 invoices;
- one tenant;
- one signed licence.

The first screen is the Arabic setup wizard ("licence embedded — activate this device"). None of the
old test data exists any more: the retired `motard-erp` data folders were deleted with the owner's
approval.

## Where things live (fixed and separated)

| What | Where | Touched by update or uninstall? |
|---|---|---|
| Program files | `%LOCALAPPDATA%\Motard ERP\` | Replaced on update; removed on uninstall |
| Database | `%LOCALAPPDATA%\MotardERP\data\motard.db` | Never |
| Keys (DPAPI, this Windows user) | `%LOCALAPPDATA%\MotardERP\keys\secrets.dat` + `.bak` | Never |
| Backups | `%LOCALAPPDATA%\MotardERP\backups\` (pre-update copies in `pre-update\`) | Never |
| Identity and state | `install.json`, `state\`, `sync\` under the same root | Never |
| Logs | `%LOCALAPPDATA%\MotardERP\logs\` | Never |

The two folder names differ only by a space ("Motard ERP" holds the program, "MotardERP" holds the
data). Support staff should know this.

## Lifecycle evidence

All runs used the real shell. Rows marked "installed build" used the release installer. Every run
used an isolated `MOTARD_DATA_ROOT`; the real customer root was never created on this machine.

| Scenario | Result |
|---|---|
| First install, first run | FRESH: keys created, database created, healthy in 4.6 s, setup wizard shown (installed build) |
| Normal restart | REUSE: same `dataId` |
| Close the window | `DESKTOP_SHUTDOWN_CHECKPOINTED`; WAL folded into `motard.db`; backend gone; about 1 s |
| **Update over existing data** (previous version 2.9.0) | Verified pre-update copy (sha256 checked per file) taken **before** the new version opened the data. REUSE, marker customer kept, `integrity_check = ok` |
| **Failed update** (forced bad migration) | The new version refused to open the data and showed the recovery screen. Database unchanged (marker present, schema index unchanged, integrity ok). The "restore the pre-update copy" action is offered |
| Re-install over the top | REUSE: same `dataId`, marker kept (installed build) |
| Uninstall, then install again | Uninstall removed program files only; database and keys stayed. Re-install reopened the same company (installed build) |
| Shell killed hard (crash, stand-in for a power cut) | The Job Object killed the backend too. Next boot ran `integrity_check` on REUSE and came up healthy (installed build) |
| Both key files corrupted, data present | Boot stopped on `KEYS_UNREADABLE`. **No replacement keys generated**, key file byte-for-byte unchanged, backend never started |
| Secret leakage | The decrypted `APP_MASTER_KEY` / `JWT_SECRET` appear in none of the 10 log/state files or in the database |
| Staged program files | Gate: no `.env` file, no private-key material in any of 249 files |

## Test suites (2026-10-13, after all changes)

| Suite | Result |
|---|---|
| Frontend `npx vitest run` | 99 files, 425 tests passed |
| Backend on SQLite (desktop engine) | 182 files passed (10 skipped), 995 tests passed (43 skipped) |
| Backend on PostgreSQL (disposable cluster, port 56437) | 193 files, 1042 tests passed |
| Desktop shell `cargo test` | 19 passed: keys, startup decision, pre-update copy + rollback, pipe parser, env contract, archive names, boot-failure capture |
| `tsc` (root, backend), `typecheck:sqlite` | Clean |

## Open items: what was not proven, and why

1. **No clean VM.** All runs were on the development machine, isolated by data folder. A fresh
   Windows 10/11 VM run is still needed: WebView2 bootstrapper, SmartScreen, a profile with no
   Node/Rust.
2. **No real Windows restart or logoff.** It was simulated by force-killing the shell. Windows restart
   relies on the same mechanisms (Job Object, SQLite WAL, `integrity_check` on the next boot).
3. **Unsigned installer.** SmartScreen will warn ("unknown publisher"). A code-signing certificate is
   needed for a clean customer experience.
4. **Recovery actions partly proven:**
   - restore-pre-update rollback: covered by a unit test only. A GUI click on the live screen was
     abandoned (see the remediation log);
   - restore-a-backup, start-new-company and reset-keys from the recovery screen: implemented and
     confirmation-gated, but not run end to end;
   - in-app backup restore: uses the existing backend path, which is covered by the backend suites.
5. **Owner onboarding and day-to-day ERP use inside the new shell were not clicked through.** The UI
   loads and talks to the backend over the pipe. The business features are the existing UI and
   backend, covered by the suites above.
6. **Render hub: BLOCKED.** The Render MCP times out and the API answers 401 (no key). Sync against
   the hub was not re-tested this round.
7. **Not in 3.0, by design:**
   - Google Drive linking: the Drive screen says "not available in this version"; local backups
     and the Documents mirror work;
   - no online auto-update: an update means running the newer installer;
   - archived documents are saved as HTML, not PDF.
8. **Owner decisions needed:**
   - Device count in the embedded licence: the backend default is 1 device. Set
     `BAKED_LICENSE_DEVICES` before `npm run build:installer` if the customer runs several devices.
   - Invitation codes are now admin-only, as the mission requires. This reverses the 2026-10-12
     note that let the accountant invite.

## How to ship an update later (the rule that prevents data loss)

1. Bump the version in `desktop-app/src-tauri/Cargo.toml` and `tauri.conf.json`.
2. Run `cd desktop-app && npm run build:installer`. It re-stages everything and keeps the same
   tenant id.
3. The customer runs the new installer. Program files are replaced. On first start the app copies
   the database to `backups\pre-update\…` and verifies it, then migrates forward. If the migration
   fails, the data is left as it was and the recovery screen offers the copy.
