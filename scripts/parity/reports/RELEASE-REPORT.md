# Release report — Motard ERP desktop 2.0.0 (SQLite engine), 2026-10-05

**Decision: DO NOT RELEASE YET.** The release rule is "release only if every gate is PASS" (FR-062), and two things
block it:

- six lifecycle gates need clean Windows VMs that were not available (AC-4, AC-5, AC-6, AC-10, AC-11, AC-12);
- AC-8 fails as written on pre-existing shared-sync behaviors that need an owner decision.

Everything that can be verified on the developer machine passes on the exact release candidate.

## Release candidate

`Motard Fabrics Group ERP_2.0.0_x64-setup.exe`, sha256
**`17ffe64785d573402d5d8db74254877e763b8e1b27ef3e257aaf08fd831e8025`**, 31,463,363 bytes (`RELEASE-CANDIDATE.md`).
Every check below ran against this build's runtime tree, which the freshness gate ties to the installer byte for byte.
**Tested sha256 = this installer.** It has not been shipped. Whoever publishes it must confirm the published file's
sha256 equals this value (AC-2 / P-7). Any rebuild (for example a version change) produces a new artifact that must
be re-gated.

## Gates AC-1…AC-12 (details: `RELEASE-GATES.md`)

| Gate | Result |
|---|---|
| AC-1 no PostgreSQL / no port / no PG process | PASS on the developer machine (package, running instance on the named pipe, V8 coverage); VM: NOT RUN |
| AC-2 shipped = tested; no console window | hash recorded and freshness PASS; console-window check NOT RUN (VM) |
| AC-3 accounting parity | **PASS**: empty diff, 67 files, vs the frozen PostgreSQL reference |
| AC-4 lifecycle (install, reopen, kill, reboot) | NOT RUN (VM) |
| AC-5 update keeps data, no prompt | NOT RUN (VM) |
| AC-6 reinstall → PRIOR_DATA_FOUND | NOT RUN (VM) |
| AC-7 backup / restore | PARTIAL: VERIFIED v3 backup and v2 refusal on the RC; RS-5 restore in suites and in the T110 run; second-device restore on VMs NOT RUN |
| AC-8 sync | **FAIL as written**: engine parity PASS (golden wire empty diff); restore on a synced device PASS; A = B = hub fails on pre-existing shared-sync behaviors, identical with PostgreSQL desktops |
| AC-9 volume | **PASS** 18/18 (100% completeness, statement sha256 = PG baseline, full statement 8.0 s) |
| AC-10 negative cases | NOT RUN on the RC / VM (debug build 6/6) |
| AC-11 / AC-12 backup and restore in the lifecycle | NOT RUN (VM) |

## U-1 and U-2 (FR-067), stated explicitly

- **U-1 — "customer found by search, customer list empty".**
  - The **mechanisms are closed**:
    - D-3 / FR-068: a failed list load shows an error with Retry instead of an empty list (T024).
    - Track P: no page caps; lists and statements walk until the server reports the end (T022, T023). AC-9
      re-proves completeness on the RC.
    - D-4: cancelled parties are no longer mixed into operational lists (commit `d8608ac3`).
    - Debug and release builds use separate data roots, shown in Settings, so dev data can't be mistaken for customer
      data.
  - The **root cause of the original incident is NOT established**. It is not assumed fixed by the engine change.
- **U-2 — "invalid backup".**
  - The **mechanisms are closed**:
    - every v3 backup is VERIFIED after creation (archive CRC, manifest hash, `integrity_check`, per-table row counts
      and hashes) before it is listed: automatic, manual, pre-operation, pre-migration, pre-update and pre-restore;
    - files are fsynced before the atomic rename;
    - a weekly restore-test runs;
    - the manual desktop download is confirmed against the verified file's size and sha256;
    - restore verifies before it touches anything.
  - The **root cause of the original incident is NOT established**.

## Offline rules (T016) and the long-offline test (T104)

- **T016:** no licensing or sync rule is tied to being offline. Grace and token rules are application date arithmetic,
  the same on both engines.
- **T104** (1, 7, 30, 90 days offline, both engines, `offline-duration.mjs`):
  - the engines are identical (empty canonical diff);
  - the licence status is identical at every step;
  - after 90 days the device reconnects and converges with the hub.
- **SY-2 conflict, reported to the owner and NOT changed:** document number blocks are per calendar year, so a device
  offline across 1 January cannot create numbered documents (invoices, receipts) until it reconnects. This already
  exists in the PostgreSQL reference.

## Owner decisions applied in this release

- **T109, option (b):** a restore on a synced device takes a new sync identity (one extra device seat). The hub is
  unchanged.
- **T021:** the D-4 baseline fix was committed alone as `d8608ac3`. The cloud-image build context and the cert e2e
  login were fixed as test/build infrastructure only. The cert suites fail 34 stale assertions, identically before and
  after D-4.

## Open items for the owner

1. **VM runs:** T117/T118 (lifecycle on Windows 10 22H2 and 11), T082 (updater + marker), T089, T101 (restore on a
   second machine), T115 (power loss).
2. **Shared-sync behaviors** (engine-independent; `US5-sync.md`):
   - roll-creation stock movements are not synced;
   - the losing device keeps its edit after keep-server;
   - `balance_after_kg` depends on the order each node applied movements;
   - an offline cancellation's `cancelled_at` is restamped by the hub.
3. The **SY-2 year-rollover** rule above.
4. **Version 2.0.0** was chosen for the release candidate; confirm it or pick another (requires a rebuild).
5. **Performance follow-up beyond the gate** (`US6-volume.md`, T113): a 400k-line single-party statement takes about
   10 minutes because every page recomputes the full-window totals.
6. The **cert e2e suites' 34 stale assertions** (`T021-verification.md`).
7. O-1 / O-2 (`research.md` §R13c), still awaiting a decision.
