# US4 — backup, verification and restore (SQLite desktop)

Date: 2026-10-04 · Developer workstation (Windows 11), not a VM.

## Results

`node scripts/test-sqlite.mjs` on the six US4 test files: **6 files, 37/37 tests pass.**

| Area | Test file | What it proves |
|---|---|---|
| Backup format v3 (T092–T094) | `tests/sqlite/backup-v3.test.ts` (10) | creation → `.partial` → fsync → rename → full verification → registry `VERIFIED`; zip CRC, manifest hash, per-table rows + sha256, integrity + FK checks; every rejection code; the licence row is kept, device-bound columns are NULL; same-device restore keeps device state, a fresh device gets none |
| Restore, staged and atomic (T098) | `tests/sqlite/restore-rs5.test.ts` (10) | a forced failure at every step leaves the live database byte-identical; a completed restore shows exactly the archive's RS-5 figures; an archive one migration behind is migrated on staging, then swapped |
| Policy (T096, T097, T099) | `tests/sqlite/backup-policy.test.ts` (7) | pre-operation backup VERIFIED before the operation; a failed one blocks it with 503 and changes nothing; no-op on PostgreSQL; automatic backups VERIFIED with a sha256-checked mirror; 7 kept, manual / pre-operation never pruned; weekly restore-test records "RS-5 identical", leaves no temp dir, runs at most once per 7 days |
| Verified desktop download (T100) | `tests/sqlite/backup-route-desktop.test.ts` (4), `src/routes/__tests__/settings.backup.test.tsx` (5), `cargo test --bin` `save_backup_tests` (2) | the desktop receives the VERIFIED file's identity, not bytes; the shell's copy is kept only when size + sha256 match; the web path (anchor download of the streamed zip) is unchanged; registry readable by admins only |
| Restore at startup (US3 ↔ US4) | `tests/sqlite/startup-restore.test.ts` (2) | archive restored before serving; sidecar stamped with the restored identity; a rejected archive fails the boot |
| Pre-update backup (T083) | `tests/sqlite/desktop-runtime-route.test.ts` (4) | VERIFIED `pre-update` backup over the runtime-only endpoint |

## Defect found and fixed

**The desktop "export full backup" button saved a corrupted file.** The window reaches the API through
Tauri IPC → named pipe, and the pipe client decodes every response body as UTF-8 text
(`String::from_utf8_lossy`). A zip streamed that way loses every invalid UTF-8 sequence, so the saved
file looked like a backup but could not be restored. This is I-11. Fixed by T100: the desktop now asks
for metadata (`POST /api/backup/full?deliver=metadata`), and the new `save_backup_file` shell command
copies the VERIFIED file natively and re-checks size + sha256. The web/cloud path is unchanged.

## Pre-operation backups wired (BK-4)

`guardWithPreOperationBackup` runs after validation and before the transaction in:
`POST /financial-years/close`, `POST /financial-years/reopen`, `DELETE /inventory/dyes/:id/purge`,
`DELETE /customers|suppliers/:id` with `confirmCascade` (party purge), `POST /parties/merge`. A restore
makes its own `pre-restore` backup. PostgreSQL / cloud: no-op.

## Not executed here

**T101 on two VMs.** The second device is simulated by a second data root with a new installation id in
the same process (`backup-v3` "restore onto a fresh device"; `restore-rs5` RS-5 zero differences). A
restore onto a physically separate Windows installation (different DPAPI user, different device binding)
was not run, because no second VM is available on this machine.
