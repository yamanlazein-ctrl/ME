# US3 — install / update / reinstall lifecycle (developer machine)

Date: 2026-10-04 · Machine: Windows 11 Home 10.0.26300 (developer workstation, **not** a clean VM)
Build: `desktop/src-tauri/target/debug/motard-fabrics-erp.exe` (same code as the release target), data
root `%LOCALAPPDATA%\motard-erp-dev` (the release root `motard-erp`, which holds older PG-era data, was
never touched).

## What ran here

| Check | Tool | Result |
|---|---|---|
| Startup-state machine, one unit test per contract row; no test path changes a file except FRESH creation | `cargo test --lib` (db_meta, data_lock, stack, supervisor) | **93/93 pass** |
| Negative cases against the real binary: MISMATCH, PRIOR_DATA_FOUND (binding deleted), PRIOR_DATA_FOUND (marker removed), CORRUPT (truncated), LOCKED_UNKNOWN (foreign lock holder), DATA_MISSING; protected files byte-identical afterwards | `scripts/lifecycle/negative-cases.ps1` → `US3-negative-cases-dev.json` | **6/6 pass** |
| Choice flows through the real window (WebView2 + CDP, the same `startup_choose` IPC a click sends) | `scripts/lifecycle/startup-choices-e2e.mjs` → `US3-startup-choices-dev.json` | **12/12 pass** |
| Runtime endpoints for the update hand-off: 404 without token / off desktop; VERIFIED `pre-update` backup; shutdown checkpoints WAL to 0 and exits | `backend/tests/sqlite/desktop-runtime-route.test.ts` | **4/4 pass** |
| "Restore a backup" at startup: archive restored before serving, sidecar stamped with the restored identity; a rejected archive fails the boot | `backend/tests/sqlite/startup-restore.test.ts` | **2/2 pass** |

Choice flows covered by the e2e run:

1. restart with nothing changed → REUSE, no prompt
2. reinstall (new install-instance GUID) → PRIOR_DATA_FOUND with exactly *Open existing / Restore / Start new*, no corruption wording → "Open existing" opens the SAME `data_id`, records the new instance; the next restart is REUSE with no prompt
3. in-app update hand-off (`pending-update.json` naming the recorded GUID, `toVersion` = running) → REUSE with no prompt; token consumed; new instance recorded
4. reinstall → "Start new" → a NEW `data_id`; the previous database is kept in `set-aside\utc-…\`

## Defects found and fixed during this run

| # | Defect | Fix |
|---|---|---|
| 1 | The read-only startup inspection created `motard.db-wal` / `-shm` beside a database with no WAL content (data folder not byte-identical) | `db_meta::inspect_database` opens with `immutable=1` when the WAL is empty; WAL content present → normal read-only open (only SQLite's derived `-shm` index is maintained). Two unit tests. |
| 2 | The orphan reaper killed ANY process whose command line named the data root (a test runner, a backup script, robocopy) | Only a `node.exe` image started with `--data-root=<root>` is ours. Three negative cases added to the unit test. |
| 3 | "Restore a backup" moved the current data aside before the server verified the archive; a rejected archive left an empty root (next launch: a silent FRESH company) | On a failed restore boot the runtime moves the attempt aside and puts the previous data back (`db_meta::undo_set_aside`), then re-asks with the reason. Unit test. |
| 4 | New commands (`startup_status`, `startup_choose`) and `get_data_root` were missing from the Tauri ACL manifest/capabilities — the window would have been denied | Added to `build.rs` APP_COMMANDS and the recovery/main capabilities. |

## Not executable on this machine (documented, not run)

* **T082 (I-14)** — whether the NSIS `PREUNINSTALL` hook runs during an in-app *passive* update, i.e. whether the
  marker GUID changes on update. Needs a published vN → vN+1 update feed and a clean VM. The design is safe
  either way: the hand-off token makes an update REUSE whether or not the marker changes (flow 3 above).
* **T089** — quickstart §4 steps 1–9 with the *installer* on a clean Windows 11 VM (install, uninstall,
  reinstall, update via the real updater). The same states and choices were exercised here with the built
  binary and registry/file manipulation, not with the NSIS installer on a clean OS.
* The "Restore a backup" / "Locate" choices open the native file picker, which the CDP harness cannot drive;
  their data-layer behaviour is covered by the backend startup-restore test and the Rust unit tests.
