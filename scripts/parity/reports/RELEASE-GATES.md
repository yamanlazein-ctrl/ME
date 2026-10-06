# Release gates AC-1…AC-12 on the T116 release candidate (T119, T122)

Release candidate: `Motard Fabrics Group ERP_2.0.0_x64-setup.exe`, sha256
`17ffe64785d573402d5d8db74254877e763b8e1b27ef3e257aaf08fd831e8025` (`RELEASE-CANDIDATE.md`). All runs below use that
build's runtime tree (`desktop/src-tauri/target/release`, which the freshness gate ties byte for byte to the installer),
2026-10-05, on the developer machine. **No Windows 10 / Windows 11 VM was available**, so every gate that needs a
clean VM is NOT RUN.

| Gate | What | Result on the RC | Evidence |
|---|---|---|---|
| **AC-1** | no PostgreSQL in the package; no local port; no PostgreSQL process | **PASS (developer machine)**. VM install: NOT RUN | `verify-release.mjs`: no PG artefact in resources or runtime tree. Running packaged server on its named pipe: health 200 over the pipe, **0** listening TCP sockets for its node.exe, no PostgreSQL process started by the app. V8 coverage: **no PostgreSQL client function executed** (FR-040/DB-8, T122) |
| **AC-2** | the shipped EXE is the tested EXE; no console window | **PASS for the hash**. The "no console window" check needs a real launch on a VM: NOT RUN | installer sha256 above; freshness gate (exe embeds current web, installer built from current resources) |
| **AC-3** | accounting parity with the frozen PostgreSQL reference | **PASS** | `run.mjs --engine sqlite --server <RC server.mjs>` vs the frozen T026 reference re-run the same day (`out/pg-ref-20261005`): **empty diff across 67 files**. A diff against the 2026-10-04 reference output differs only in "today"-relative labels (trend days, default opening date). |
| **AC-4** | lifecycle: install → fresh → data → reopen → force-kill → reboot | **NOT RUN (VM)** | T117/T118. The debug build passed `negative-cases.ps1` 6/6 and startup choices 12/12 (`US3-*-dev.json`), and the force-kill loop passed 25/25 (`durability.md`), but none of this is the RC on a clean VM |
| **AC-5** | in-app update keeps data without a prompt (REUSE) | **NOT RUN (VM)** | T082/T089/T117/T118 |
| **AC-6** | reinstall → PRIOR_DATA_FOUND with the three choices; "start new" sets data aside | **NOT RUN (VM)** | as above (debug-build evidence only) |
| **AC-7** | backup VERIFIED; restore passes RS-5 (same device and second device) | **PARTIAL**: RC manual backup VERIFIED; v2 (PostgreSQL-era) archive refused with the correct message; restore and RS-5 covered by the suite and the T110 run on the RC. **Second-device restore on VMs: NOT RUN** (T101) | `verify-release.mjs`; `US4-backup.md`; T110 restore scenario on the RC (below) |
| **AC-8** | sync convergence A = B = hub; golden wire; restore on a synced device | **FAIL as written.** Engine parity PASS: golden wire empty diff, same results on PG and SQLite desktops. Restore on a synced device: PASS. The A = B = hub business-state check fails on **pre-existing, engine-independent** shared-sync behaviors (identical on PostgreSQL desktops) | RC run `verify-sync-multidevice.mjs --ac8 --device-engine sqlite --restore --device-server <RC>`: 17/19, the two failures being those items; `US5-sync.md` |
| **AC-9** | completeness and speed at the gate volume | **PASS** | `volume.mjs --server <RC>`: **18/18**; sha256 over every statement = PG baseline; full 40,020-line statement 7,983 ms |
| **AC-10** | negative cases (MISMATCH, binding deleted, CORRUPT, LOCKED_UNKNOWN) delete nothing | **NOT RUN on the RC / VM** | debug build 6/6 (`US3-negative-cases-dev.json`) |
| **AC-11** | backup in the lifecycle (stage 10) | **NOT RUN (VM)** | — |
| **AC-12** | restore in the lifecycle (stage 11) | **NOT RUN (VM)** | — |

## T122 — FR-040 / DB-8 on the RC: **PASS 10/10**

`node scripts/parity/verify-release.mjs`:

- freshness gate;
- no PostgreSQL artefacts (resources and runtime tree);
- packaged onboarding and sale;
- VERIFIED v3 backup;
- a **real** PostgreSQL-era v2 archive (exported by the PostgreSQL backend) refused with
  «هذه نسخة احتياطية من إصدار PostgreSQL السابق (PostgreSQL-era backup) ولا يمكن استعادتها في هذا الإصدار»
  (`BACKUP_UNSUPPORTED_FORMAT`);
- graceful shutdown;
- V8 coverage over the 33 bundled PostgreSQL module regions: **0 executed functions**.

Two defects were found and fixed on the way. Both are in the RC.

1. The restore error mapper hid the PostgreSQL-era refusal behind a generic "restore failed" with English internals
   (`RESTORE_VERIFY_FAILED`). It now unwraps the archive refusal. Regression test:
   `tests/sqlite/backup-route-desktop.test.ts`.
2. `runDesktopMigrations.ts` statically imported `drizzle-orm/node-postgres/migrator`, so a SQLite process evaluated a
   PostgreSQL module. It is now imported lazily, and `trace-pg-imports.mjs` now also flags `drizzle-orm/node-postgres`.

## Verdict

**Not releasable yet** (FR-062: every gate must PASS on the final package):

- AC-4, AC-5, AC-6, AC-10, AC-11 and AC-12 need the Windows 10 22H2 and Windows 11 VMs (T117/T118, with T082, T089,
  T101 and T115).
- AC-8 fails as written on pre-existing shared-sync behaviors that need an owner decision (`US5-sync.md`).
