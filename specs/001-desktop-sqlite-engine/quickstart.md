# Quickstart: Validating the SQLite Desktop Build

**Feature**: `001-desktop-sqlite-engine` | **Date**: 2026-10-03

This is a run guide for proving the feature works. It names the checks and their expected outcomes. Commands marked
**(planned)** are created by the tasks for the corresponding stage (see plan §Implementation Order). Commands without that mark exist
today. Gate IDs refer to the spec and PRD.

## Prerequisites

- The reference PostgreSQL desktop build (release 1.2.x), frozen and hashed at stage S0.
- A clean Windows 10 22H2 x64 VM and a clean Windows 11 x64 VM, each with a snapshot "clean". No prior Motard data.
- A PostgreSQL hub reachable from both VMs (the existing Docker deployment), reset to a fresh tenant for each sync run.
- The repository with `backend/` deps installed. A local PostgreSQL is needed for the reference tests
  (`npm run db:test:setup`).

## 1. Engine conformance (developer machine, per stage)

| Step | Command | Expected |
|---|---|---|
| Reference suite | `cd backend && npm test` | green on PostgreSQL (unchanged baseline) |
| SQLite suite **(planned)** | `cd backend && DB_ENGINE=sqlite npm test` | the same tests green on SQLite |
| Schema parity **(planned)** | `node backend/scripts/compare-schema-fingerprints.mjs` | only the allowed deltas from [data-model.md §1](./data-model.md) |
| Tenant isolation **(planned)** | `DB_ENGINE=sqlite npx vitest run tests/tenant-isolation` | zero cross-tenant rows through every port |

## 2. Accounting parity (AC-3, SC-001)

| Step | Command | Expected |
|---|---|---|
| Run scenarios on both engines **(planned)** | `node scripts/parity/run.mjs --engine postgres --out ref/` then `--engine sqlite --out sut/` | both complete |
| Compare **(planned)** | `node scripts/parity/diff.mjs ref/ sut/` | **empty diff**: statements, balances, ledger, cash box per currency (SYP/USD/EUR), stock, relationships, `cashbox_daily_balances` row-for-row |
| Edge cases | included in the scenario set | rounding `x.xx5`, cancellations, purge (party and dye), merge, year close and reopen, concurrent same-roll and same-number |
| Cancelled records (D-4) | included in the scenario set | a cancelled party is absent from every operational list, including "all", on **both** engines, and still resolves by id on its historical documents, statements and audit |
| Schema parity | `compare-schema-fingerprints.mjs` **(planned)** | 53 tables, 73 enforced FKs identical. `party_balances` absent. The 24 non-enforced tenant references remain non-enforced. |

## 3. Durability (SC-004)

- **Force-kill**: loop multi-record saves (invoice + ledger + cash + stock) and kill the backend with `taskkill /F` at random points
  (`backend/scripts/durability-proof.mjs`, extended for SQLite). Expected: every document is complete or absent, and every
  confirmed save is present.
- **Power loss**: on the VM, hard-reset the VM during the same loop, at least 20 times. Expected: as above, `integrity_check` = `ok`.

## 4. Lifecycle protocol (AC-4–6, AC-10–12, SC-003, SC-005)

On **each** VM, from the "clean" snapshot, using the final packaged EXE (its sha256 is recorded):

1. Install.
2. First run. Expect state `FRESH`, empty data.
3. Create realistic data with the parity scenario set.
4. Close and reopen. Data unchanged.
5. Force-kill, then restart. Data unchanged.
6. Restart Windows. Data unchanged.
7. Update to the next build while running. Expect state `REUSE` with no prompt, the same `data_id` and data unchanged.
8. Uninstall. `%LOCALAPPDATA%\motard-erp` and the backups remain.
9. Reinstall. Expect state `PRIOR_DATA_FOUND`, offering Open existing data / Restore a backup / Start a new project
   (decision D-1). Choose "Open existing": data unchanged. Repeat from a snapshot choosing "Start new": the old data is
   in `set-aside\`, not deleted.
10. Back up. Status VERIFIED.
11. Restore. The RS-5 comparison passes.

After each stage, compare record counts and balances with the stage-3 snapshot. Extra negative cases:

- copy another VM's data root in → `MISMATCH`
- delete the device binding → `PRIOR_DATA_FOUND`
- truncate the database file → `CORRUPT`
- hold the database with a foreign process → `LOCKED_UNKNOWN`

None of these may delete data.

## 5. Backup and restore (AC-7, SC-006, SC-012)

- Manual, automatic, pre-operation and pre-restore backups: each reaches VERIFIED in `backups.json`.
- Corruption injection: flip one byte in each zip member, and truncate the zip. Each must be rejected.
- Restore on the same VM and on the other VM. The RS-5 comparison has zero differences.
- Restore-test: advance the clock 7 days and confirm the weekly silent restore-test record.
- Retention: after 8 automatic days, exactly 7 VERIFIED automatic backups remain, in both locations.

## 6. Sync convergence (AC-8, SC-007)

Device A creates 20 invoices offline and device B creates 30. Include a same-record edit and a same-roll consumption. Then reconnect.
Expected: A, B and the hub each have 50 invoices and identical document numbers, parties, balances, ledger, inventory and cash box
(`backend/scripts/verify-sync-multidevice.mjs`, extended **(planned)**). Then run the golden wire comparison from
[contracts/sync-wire-compat.md](./contracts/sync-wire-compat.md).

Restore on synced device B (OQ-12). Expected: sync paused, newer units auto-pulled, no re-push of acknowledged units, and
review mode only on conflict.

## 7. Volume and history (AC-9, SC-008)

- Prerequisite: track P (pagination) has landed, and the PostgreSQL completeness baseline has been re-taken.
- Gate: 100,000 invoices, 200,000 ledger rows and 10,000 parties. List screens and a statement's first page must load in under 2 s,
  and a complete single-party statement in under 10 s. 100% of baseline rows must be reachable.
- Soak (report only): 1,000,000 invoices.

## 8. Packaged-build checks (AC-1, AC-2, SC-002)

- Unpack the installer. It contains no `postgres.exe`, `pg_ctl.exe`, `initdb.exe`, `pg_dump.exe`, `pgdata-template\` or `db-port.txt`.
- On a running instance:
  - `Get-NetTCPConnection -State Listen -OwningProcess <node pid>` returns **no** rows;
  - no `postgres` process exists;
  - no console window is visible.
- The shipped EXE's sha256 equals the tested EXE's sha256 (P-7).
