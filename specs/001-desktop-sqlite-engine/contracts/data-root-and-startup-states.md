# Contract: Data Root, Identity and Startup States (Rust runtime ↔ backend ↔ UI)

## Data root

`%LOCALAPPDATA%\motard-erp\` for the release build, `motard-erp-dev` for debug builds (unchanged rule). It is per Windows
user (ID-1, ID-2) and independent of the EXE location. The uninstaller never touches it (`windows/hooks.nsh`,
unchanged).

File layout: see [data-model.md §3](../data-model.md).

## Runtime → backend environment (replaces `DATABASE_URL`, PostgreSQL env)

| Var | Value |
|---|---|
| `DESKTOP_DEPLOY` | `true` (unchanged) |
| `DESKTOP_PIPE` | named pipe path (unchanged) |
| `DB_ENGINE` | `sqlite` |
| `SQLITE_PATH` | `<root>\data\motard.db` |
| `MOTARD_INSTALLATION_ID` | device-binding installation id |
| `MOTARD_DATA_ID` | expected `motard_meta.data_id` (the backend refuses to serve on mismatch); on FRESH, the `data_id` to mint |
| `MOTARD_STARTUP_STATE` | `FRESH` (the only state allowed to create the database file), `REUSE` or `OPEN_EXISTING` |
| `MOTARD_INSTALL_INSTANCE_ID` | HKCU install-instance GUID (D-1), recorded in `motard_meta` at creation |
| `JWT_SECRET`, `APP_MASTER_KEY`, `CENTRAL_SYNC_URL`, `LICENSE_SIGNING_PUBLIC_KEY`, `MOTARD_BOOT_ID`, `MOTARD_APP_VERSION` | unchanged |

No `PGPASSWORD`, no `DATABASE_URL`, no port.

## Startup states (exposed to the UI by `recovery_status`)

| State | Trigger | Options shown | Automatic action |
|---|---|---|---|
| `FRESH` | empty data root | — | create database, mint `data_id` |
| `REUSE` | binding + sidecar + meta agree **and** same install instance (HKCU marker GUID = `motard_meta.install_instance_id`) or a valid update hand-off token: a normal restart or application update | — | open |
| `PRIOR_DATA_FOUND` | data present and this is a **new installation**: new install-instance GUID without a matching update token, or a new or absent device binding | **Open existing data / Restore a backup / Start a new project** | none until the user chooses. "Open existing" records the new install instance. "Start new" moves the data aside. |
| `MISMATCH` | sidecar ≠ meta, or installation/tenant mismatch | Restore backup / Start new / Show details | none |
| `CORRUPT` | integrity check fails or not SQLite | Restore backup / Start new / Show details | none |
| `TOO_NEW` | schema newer than binary | Install newer version | none |
| `DATA_MISSING` | evidence of prior data but no database | Restore / Locate / Start new | none |
| `LOCKED_UNKNOWN` | lock held by a non-Motard or unknown process | Retry / Show holder | halt |
| `SERVICE_STOPPED` | more than 3 backend restarts in 5 min | Restart app / Show log | stop retrying |

"Start new" always moves existing data to `set-aside\<timestamp>\` and never deletes it.

## Install-instance identity (D-1)

| Artifact | Writer | Remover |
|---|---|---|
| `HKCU\Software\MotardFabricsErp\InstallInstanceId` (GUID) | NSIS `POSTINSTALL` hook, only if absent | NSIS `PREUNINSTALL` hook (HKCU only; AppData untouched) |
| `<root>\pending-update.json` | the app, immediately before applying an in-app update | the app, after the first successful post-update open |
| `motard_meta.install_instance_id` | the backend, on REUSE-after-update or an explicit "Open existing" | never removed |

An update never produces `PRIOR_DATA_FOUND`. A fresh install after an uninstall always does, if data exists.

## Connection info (`get_data_root`, ID-7)

`{ profile, dataRoot, databasePath, dataId, tenantId, companyName, schemaJournalIdx, pipe }`
