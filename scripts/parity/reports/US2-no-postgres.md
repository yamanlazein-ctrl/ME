# US2 — the desktop runs without PostgreSQL (2026-10-04)

**Result: PASS on this machine.** The full-application launch on a clean Windows 10/11 VM is not
executable here and is listed under "Not run".

## Installer

`desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_1.2.0_x64-setup.exe`

- Built with `npm run tauri:release` (exit 0).
- Size: 29.3 MB. The PostgreSQL reference installer was 53.6 MB.
- Every gate in `before-build.cmd` passed: Node staging, SPA, server bundle, desktop seed,
  `server-bundle.test.mjs`, resource manifest, `verify-no-postgres`, and freshness pre.
- The freshness post gate passed: `target/release` copies are byte-identical to `resources`, the
  executable embeds all 33 current web assets, and the installer was built from the current resources.

## SC-002 checks (`desktop/scripts/verify-no-postgres.mjs`)

| Target | Result |
|---|---|
| `desktop/src-tauri/resources` (what Tauri packages) | PASS |
| App runtime folder (exe, node.exe, server/, licence key, copied from `target/release`) | PASS |
| Installer, uncompressed parts* | PASS |
| **Running instance**: packaged `node.exe server.mjs`, spawned as `stack.rs` does (FRESH, temp root) — process tree `node.exe`, `conhost.exe` | PASS: no PostgreSQL process, **no listening TCP port** |
| Control: `desktop/retired-postgres` (the retired PG runtime) | FAIL as expected; all 10 artefacts named |

\* NSIS stores its file list LZMA-compressed. The authoritative check is the unpacked tree it is built
from, which `before-build.cmd` also gates. `tauri.conf.json` `bundle.resources` maps only `node.exe`,
`server` and `license-public.pem`, enforced by `dfp001-staging-gate.test.mjs`.

## Packaged-runtime end-to-end (`desktop/scripts/server-bundle.test.mjs`, 7/7)

The test uses the bundled `node.exe` and the packaged `server/`. It checks:

- FRESH creates `data\motard.db` with the runtime's `data_id` and install instance, and the sidecar.
- First-run content is exactly the default tenant plus the signed licence, with zero users.
- The API answers on the named pipe and the server takes no TCP port: 8080 and 4173 decoys stay
  theirs.
- SPA, CSP and JSON errors are served correctly.
- A restart reopens the database with REUSE.
- A new install instance is refused with `INSTALL_INSTANCE_MISMATCH` and the file stays byte-identical.

## Desktop runtime (Rust, `cargo test --lib`: 89 passed)

| Task | Change |
|---|---|
| T068 | `stack.rs` spawns only Node, with `DB_ENGINE=sqlite`, `SQLITE_PATH`, `MOTARD_STARTUP_STATE`, `MOTARD_DATA_ID`, `MOTARD_INSTALLATION_ID`, `MOTARD_INSTALL_INSTANCE_ID` and the seed and migrations paths. No PostgreSQL lifecycle and no `DATABASE_URL`/`PGPASSWORD`. |
| T069 | `ports.rs` and `cluster_identity.rs` deleted. No `db-port.txt`. |
| T070 / T067 | Restart bound: 3 per rolling 5 minutes, then `SERVICE_STOPPED`. The message has no corruption wording. Tests cover the bound. |
| T071 | `data_lock.rs`: exclusive `motard.lock` plus an owner record. A previous instance of the same installation is waited for, then terminated. An unknown holder gets `LOCKED_UNKNOWN`. It never deletes and never kills itself. Tests cover each case. |
| T072 | `tauri_plugin_single_instance` is the first plugin. A second launch exits inside `Builder::build()` and focuses the first window, before the data lock is touched. Verified statically. |
| T073 | PostgreSQL removed from `tauri.conf.json`, the manifest, `before-build.cmd` and `bundle-server`. The PG scripts and binaries moved to `desktop/retired-postgres/` (git-ignored binaries; nothing deleted). |
| T075 | NSIS `POSTINSTALL` writes the `HKCU\Software\MotardFabricsErp\InstallInstanceId` GUID only if it is absent. `PREUNINSTALL` removes it. AppData is never touched. |
| T076 | `db_meta.rs` decides FRESH / REUSE / halt from files only. Tests check that no file changes. The backend re-checks against `motard_meta` (`INSTALL_INSTANCE_MISMATCH`, `INTEGRITY_FAILED`, `DATA_ID_MISMATCH`). |
| T077 / T048 | FRESH creation plus `desktop-seed.json` (`build-desktop-seed.mjs`, key-pair gate). The better-sqlite3 addon loads with the bundled node.exe and keeps 64-bit integers exact (validator). |

## Not run here (needs the Windows 10 22H2 / Windows 11 VMs, T089 and T117)

- Installing the built EXE and launching the full application on a clean VM, then running
  `verify-no-postgres --pid <app pid>` on the whole app process tree.
- Launching the release EXE on this machine. It would use the real `%LOCALAPPDATA%\motard-erp`,
  which holds this machine's PostgreSQL-era data, so it was deliberately not run. The new build would
  halt with `LEGACY_PG_DATA` without changing a file.
