# Implementation Plan: Desktop Local Database Replacement (PostgreSQL → SQLite)

**Branch**: `001-desktop-sqlite-engine` (spec directory; work currently on `clean-desktop-release`) |
**Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-desktop-sqlite-engine/spec.md`

Companion artifacts: [research.md](./research.md) (decisions + evidence),
[data-model.md](./data-model.md) (schema inventory, types, triggers, state machines),
[contracts/](./contracts/) (engine boundary, backup v3, data root/startup states, sync wire), and
[quickstart.md](./quickstart.md) (validation guide).

## Summary

Replace the desktop's embedded PostgreSQL 17 server with an embedded SQLite file, opened in-process by the existing
Node/Express backend through `better-sqlite3`. The same backend keeps serving the cloud on PostgreSQL,
unchanged.

**Approach**:
1. Put an engine boundary at the existing repository ports.
2. Add SQLite repository implementations beside the PostgreSQL ones.
3. Reproduce the **live** PostgreSQL schema, reconciled from all 100 migrations: 53 live tables (54 ever created, 1
   intentionally dropped), 73 enforced FKs, 213 indexes, 45 CHECKs and 7 triggers. Money uses exact-decimal integer storage.
4. Replace the row and advisory locks with a single serialized writer.
5. Redesign identity, lifecycle and backup in the Rust runtime and backend around a single database file.
6. Prove 1:1 behavior against the frozen PostgreSQL build with conformance, parity, sync, durability and EXE-lifecycle
   tests.

No customer-data migration and no business-logic changes.

## Technical Context

**Language/Version**: TypeScript 5.8 on Node.js 22.14.0 (bundled `node.exe`); Rust (Tauri v2 desktop shell);
React SPA in WebView2 (unchanged)

**Primary Dependencies**:
- Express 4, `drizzle-orm` 0.45 (`pg-core` for cloud, plus `sqlite-core` for desktop), `pg` 8 (cloud only)
- **`better-sqlite3`** (new, desktop only)
- `fflate` (zip), zod, pino
- Tauri plugins: single-instance, updater, autostart

**Storage**:
- Cloud: PostgreSQL (unchanged).
- Desktop: one SQLite file `%LOCALAPPDATA%\motard-erp\data\motard.db` (WAL, `synchronous=FULL`, `foreign_keys=ON`).
- Runtime sidecars per [data-model.md §3](./data-model.md).

**Testing**:
- vitest backend suite (113 files) parameterized by `DB_ENGINE`
- frontend vitest (59)
- e2e `cert-financial`, `cert-route` and `cert-ui`
- new parity harness and fingerprint comparison
- existing harnesses: `durability-proof.mjs`, `restore-drill.mjs` and `verify-sync-multidevice.mjs`
- VM lifecycle protocol

**Target Platform**: Windows 10 22H2 x64 and Windows 11 x64 (OQ-1), per-user install. The cloud is Linux Docker
(unchanged).

**Project Type**: Desktop application (Tauri shell + bundled Node backend + SPA) sharing a backend with a web
service.

**Performance Goals** (OQ-4): at 100k invoices, 200k ledger rows and 10k parties, list screens and the first page of a statement load in under 2 s,
and a full single-party statement in under 10 s. There is also a 1M-invoice soak run, reported only.

**Constraints**:
- Exact parity with the PostgreSQL build (C-1).
- No local TCP port (RT-1).
- No silent database creation or deletion (C-13).
- Durable commits (C-10).
- No artificial limits (C-11).
- Clean start with no data migration (DB-8).
- Cloud behavior unchanged (FR-006).

**Scale/Scope**:
- 53 tables
- about 34 repository classes plus helpers to provide on SQLite
- about 25 non-repository files that build queries, to move behind ports, plus about 15 transaction-only routes to repoint to an
  engine-neutral transaction facade (12 of the 25 import `drizzle-orm` directly)
- about 200 PostgreSQL references in `runtime/stack.rs` to remove or replace
- 100 PostgreSQL migrations collapsed into one SQLite baseline

No `NEEDS CLARIFICATION` remains. The spec's OQ-1–12 are resolved, and the evidence gaps are listed as Investigation Items
below. Each is scheduled before the stage that depends on it.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | How this plan complies | Status |
|---|---|---|
| I. SQLite only, no server, no port (constitution v1.1.0) | `better-sqlite3` in-process. PostgreSQL binaries, `pgdata`, `pg_dump`, ports and `db-port.txt` are removed (S7, S9). Named pipe kept. Cloud behavior is unchanged (R2), except for the **approved pre-reference defect fixes** (D-3, D-4, track P; spec FR-070). Those are explicit owner-approved fixes of PRD defects P-5/P-8, applied to the PostgreSQL behavior before the reference freeze. They are not engine-change side effects. All other shared-code edits (S1 moves, engine branches, desktop-only UI paths) must leave cloud behavior identical, proven by tasks T031 (S1 proof) and T100 (web backup-download check). Verified by quickstart §8. | PASS |
| II. Behavioral and accounting parity | PostgreSQL build frozen as the oracle in S0, **after** the P-5 cancelled-record defect is fixed in shared code (D-4, R14a). The defective behavior is never the reference. DB-7 inventory in research R7. Exact decimals (R5). Parity harness with an empty-diff gate (R14). | PASS |
| III. Complete schema, relationships and history | Live schema reconciled from the full migration history ([data-model §1.0](./data-model.md)): 53 live tables (incl. 3 raw-SQL-only) and 73 enforced FKs. `party_balances` was historically dropped by `0038`. The 24 non-enforced Drizzle tenant references are kept non-enforced (R8). Genome counts are superseded and recorded. `ledger_entry_archive` kept. FKs enforced per connection. | PASS |
| IV. Atomic and durable writes | `BEGIN IMMEDIATE` single writer. Transaction clock. WAL + `synchronous=FULL`. Durability proven by kill and hard-reset tests (R3, R4). | PASS |
| V. No artificial limits | No new caps. Writer queue unbounded. Keyset preserved. Track P removes the existing caps before acceptance (R15). | PASS |
| VI. Data identity and safe lifecycle | The state machine never deletes or substitutes ([contracts/data-root-and-startup-states.md](./contracts/data-root-and-startup-states.md)). A new installation that finds data always asks: Open existing / Restore / Start new (D-1). Updates reuse automatically via the install-instance marker and update hand-off token. Lock-owner checks. Uninstall keeps data. Forward-only migrations. The backend installation identity is per user and linked to the device binding (D-2). | PASS |
| VII. Verified backup and restore | Format v3 with one `createAndVerify` for every path, fsync + rename, VERIFIED registry, staging restore, RS-5 comparison, weekly restore-test (R10). | PASS |
| VIII. Offline-first sync fidelity | Device-side sync tables kept intact. Payloads built by the unchanged app layer. Golden wire test. OQ-12 restore flow (R13). | PASS |
| IX. Preserve domain logic | Changes confined to infrastructure, DI, runtime and backup. The S1 move behind ports is behavior-preserving and proven on PostgreSQL. No UI redesign; only the PRD-mandated startup and backup states are new. | PASS (see Complexity Tracking) |
| X. Packaged EXE is the truth | Gates run on the hashed final EXE on both VMs. Release blockers are listed below. | PASS |

**Gate result (pre-research)**: PASS. **Gate result (post-design)**: PASS. The design artifacts introduce no
new violations. The justified deviations are in Complexity Tracking.

## Coverage of required planning topics

| # | Topic | Where |
|---|---|---|
| 1 | Current architecture and target desktop/cloud boundary | §Architecture below; research F3, R2 |
| 2 | SQLite driver and connection lifecycle | research R1, R3, R4 |
| 3 | Shared backend serving SQLite (desktop) and PostgreSQL (cloud) | research R2; [contracts/db-engine-port.md](./contracts/db-engine-port.md) |
| 4 | Repository and infrastructure changes for both engines | §Project Structure; stages S1–S4 |
| 5 | Full schema parity (tables incl. raw-SQL-only, FKs, indexes, constraints, triggers) | [data-model.md §1–4](./data-model.md); research R8 |
| 6 | PostgreSQL-specific behavior inventory → SQLite | research R7 |
| 7 | Transactions and durability for financial operations | research R3, R4 |
| 8 | Exact-decimal money; SYP/USD (and EUR) parity | research R5; data-model §2 |
| 9 | Ledger and cash box parity | data-model §4 (T1–T4); research R7; parity harness |
| 10 | Search parity incl. Arabic | research R9 |
| 11 | Installation and data identity redesign | research R11; data-model §3, §5.1 |
| 12 | Safe install/update/uninstall/reinstall | contracts/data-root-and-startup-states.md; quickstart §4 |
| 13 | File locking and single instance | research R12 |
| 14 | Backup format, verification, restore and automatic policy | research R10; contracts/backup-format-v3.md |
| 15 | Local SQLite ↔ remote PostgreSQL sync, conflicts and convergence | research R13; contracts/sync-wire-compat.md |
| 16 | Pagination and history completeness with no product limits | research R15; Principle V row above |
| 17 | Separate pagination-fix track before acceptance | research R15; stage S0/P |
| 18 | Test strategy PostgreSQL vs SQLite | research R14; quickstart §1–2 |
| 19 | Windows 10 22H2 and Windows 11 lifecycle testing | quickstart §4 |
| 20 | Final packaged-EXE acceptance and release blockers | §Release Blockers; quickstart §8 |
| 21 | Implementation order in small stages | §Implementation Order |
| 22 | Rollback and safety per stage | §Implementation Order (Rollback column) |

## Architecture

**Current**:

```text
Tauri (Rust) ──► spawns PostgreSQL 17 (pgdata, dynamic TCP port) + Node backend (named pipe)
Node backend ──► pg Pool (RLS GUCs) ──► PostgreSQL
SPA ──(Rust `api` command)──► named pipe ──► Express
Backend also = cloud server (Docker, PostgreSQL 16) — same server.ts
```

**Target**:

```text
Tauri (Rust) ──► acquires motard.lock, resolves startup state, spawns Node backend only
Node backend (DB_ENGINE=sqlite) ──► better-sqlite3: writer (gated, BEGIN IMMEDIATE) + reader (WAL)
                                ──► %LOCALAPPDATA%\motard-erp\data\motard.db
SPA ──► named pipe ──► Express        (unchanged)
Cloud (DB_ENGINE=postgres default) ──► unchanged Postgres*Repository + pg Pool
Desktop ⇄ central PostgreSQL hub over HTTPS sync API (unchanged protocol)
```

**Boundary rule**: everything above `application/ports` is shared and unchanged. Below it there are two
infrastructure families selected once, at process start.

## Project Structure

### Documentation (this feature)

```text
specs/001-desktop-sqlite-engine/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   ├── db-engine-port.md
│   ├── backup-format-v3.md
│   ├── data-root-and-startup-states.md
│   └── sync-wire-compat.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root; ★ new, ✎ changed, ✗ removed from desktop build)

```text
backend/
├── src/
│   ├── application/
│   │   ├── ports/                      ✎ add ports for the ~25 non-repository query files (S1)
│   │   └── use-cases/                  ✎ S1 only: call ports instead of drizzle directly (no logic change)
│   ├── infrastructure/
│   │   ├── config/env.ts               ✎ DB_ENGINE, SQLITE_PATH, MOTARD_INSTALLATION_ID, MOTARD_DATA_ID
│   │   ├── di/container.ts             ✎ engine selection
│   │   ├── orm/
│   │   │   ├── drizzle.ts              ✎ PostgreSQL only, lazy-loaded
│   │   │   ├── sqlite/                 ★ connection, write gate, ambient tx, pragmas, tx clock, custom types
│   │   │   │   ├── schemas/            ★ sqlite-core table definitions (53)
│   │   │   │   └── migrations/         ★ 0000_baseline.sql + journal + fingerprint
│   │   │   └── runDesktopMigrations.ts ✎ SQLite migration runner + fingerprint verify
│   │   ├── repositories/
│   │   │   ├── Postgres*Repository.ts  (unchanged)
│   │   │   └── sqlite/Sqlite*Repository.ts ★
│   │   ├── backup/                     ✎ v3 createAndVerify / restore for sqlite; v2 kept for cloud
│   │   ├── integrity/snapshot.ts       ✎ sqlite path uses online backup (no pg_dump)
│   │   ├── installation/               ✎ per-user install-id path on desktop (D-2)
│   │   └── errors/persistenceErrorMessage.ts ✎ map SQLite constraint errors to the same codes
│   └── presentation/server.ts          ✎ engine bootstrap; no other route changes
├── scripts/
│   ├── compare-schema-fingerprints.mjs ★
│   └── durability-proof.mjs / restore-drill.mjs / verify-sync-multidevice.mjs  ✎ engine-aware
└── tests/                              ✎ engine-parameterized; ★ tenant-isolation, trigger, decimal, search parity
scripts/parity/                         ★ run.mjs, diff.mjs, scenarios/
desktop/
├── scripts/
│   ├── bundle-server.mjs               ✎ ship better-sqlite3 .node next to server.mjs
│   ├── build-pgdata-template.mjs       ✗ (desktop) — template no longer built
│   ├── prune-postgres.mjs              ✗
│   └── resource-manifest.json          ✎ remove postgres entries; add sqlite addon
└── src-tauri/src/
    ├── runtime/stack.rs                ✎ remove PG boot; spawn backend with SQLite env
    ├── runtime/ports.rs                ✗
    ├── runtime/cluster_identity.rs     ✗ → replaced by data_id check
    ├── runtime/supervisor.rs           ✎ restart bound 3 / 5 min (OQ-2)
    ├── db_meta.rs                      ✎ new sidecar schema + startup state evaluation
    ├── data_lock.rs                    ★ motard.lock owner identification
    ├── lib.rs / main.rs                ✎ connection info (tenant, data_id); startup-state commands
    └── windows/hooks.nsh               ✎ add install-instance marker (write if absent / remove on uninstall; HKCU only — still never touches AppData)
src/                                    ✎ minimal: startup-state screens, backup VERIFIED status,
                                          native save for backup download (no business UI change)
```

**Structure decision**: keep the existing monorepo layout. SQLite code lives in parallel `sqlite/` subfolders
under `infrastructure/`, so the PostgreSQL code is not edited for SQLite purposes.

## Investigation Items (evidence missing; each is a task before its dependent stage)

| ID | Question | Blocks |
|---|---|---|
| I-1 | How to ship the `better-sqlite3` native addon through the esbuild bundle and resource manifest | S3 |
| I-2 | Call sites that use the global `db` inside another transaction's scope (autonomous commit in PostgreSQL), starting with `documentNumbers.ts:133` | S3/S4 |
| I-3 | SQL-side arithmetic that mixes numeric scales (amount × rate, qty × price in SQL) | S4 |
| I-4 | The JS type the current Drizzle `date` columns return | S2 |
| I-5 | Any hashing or text comparison of jsonb values (key-order sensitivity) | S4, S8 |
| I-6 | Code that relies on equal `now()` within a transaction | S3 |
| I-7 | The exact dye-purge ledger predicate around the runtime trigger drop/recreate (`dyePurgeRepository.ts:~595`) | S4 |
| I-8 | Exact bodies of `cashbox_daily_apply_delta`, `cashbox_daily_shift_all` and the latest `fn_ledger_entries_append_only` | S2 |
| I-9 | Whether a desktop (not the hub) ever writes `sync_inbox` | S8 |
| I-10 | Whether every PostgreSQL repository query carries a `tenant_id` predicate, or some rely on RLS alone | S4 |
| I-11 | Replacing the WebView2 anchor download with a verified native save | S6 |
| I-12 | How already-acknowledged outbox units are identified after restore | S8 |
| I-13 | Whether the desktop connects to PostgreSQL as superuser (which would mean RLS is not enforced on desktop today) | S0 (affects the parity reference) |
| I-14 | Whether the Tauri v2 NSIS updater runs the old uninstaller (`PREUNINSTALL`) during an update, and whether the hook can detect update mode (D-1 mechanism: decides whether the hand-off token is the primary path or the fallback) | S7 |
| I-15 | Every operational list path (backend endpoints, frontend caches, pickers) for parties, invoices, vouchers, returns and orders: does each exclude cancelled records? (D-4, FR-017) | S0 |
| I-16 | Authoritative inventory of non-repository files that touch the database, each classified as *query* (must move behind a port) or *transaction-only* (engine-neutral facade). Estimated at ~25 query files plus ~15 tx-only routes (tasks T015) | **S1: blocking.** S1 may not start until this inventory is complete and recorded. |
| I-17 | Every offline time rule in licensing and sync (`licenses.grace_days`, offline-token expiry, `offline_grace_started`) and its effect after N offline days on the PostgreSQL reference (FR-055, SY-2) | S0 (reference), S8 (parity) |
| I-18 | Columns in kept tables that reference excluded device-bound tables (beyond `tenants.activation_id`), and their FK actions (backup v3 copy rules) | S6 |

## Decisions (from the spec Clarifications)

| ID | Decision | Resolution | Status |
|---|---|---|---|
| D-1 | New installation vs update | **Owner-decided 2026-10-03.** A new installation that finds existing company data MUST offer Open existing data / Restore a backup / Start a new project, and never reuses silently. A normal application update reuses the data automatically. Mechanism: an install-instance GUID in HKCU (written by the installer if absent, removed by the uninstaller), recorded in `motard_meta`, plus an update hand-off token (research R11; contract). | **Decided** (mechanism detail: I-14) |
| D-2 | Backend installation-id scope | **Owner-decided 2026-10-03.** Desktop: per Windows user at `%LOCALAPPDATA%\motard-erp\install-id`, seeded from and linked to the device-binding installation id (ID-2, spec FR-069). Cloud unchanged. | **Decided** |
| D-3 | A failed list load shows empty | **Owner-decided 2026-10-03.** A failed list or cache load shows a clear error with Retry, never a false empty state (spec FR-068). Delivered on track P as an approved pre-reference defect fix (FR-070). | **Decided** |
| D-4 | Cancelled records in operational lists | **Owner-decided 2026-10-03.** Cancelled customers (and suppliers) never appear in normal operational lists, including the default "all" view. They are preserved and reachable for audit and history, and by-id lookups on historical documents keep working. The current PostgreSQL behavior is the P-5 defect, **not** the parity reference. It is fixed in shared code in S0 before the reference is frozen. Same audit for other entities (I-15). | **Decided** |

## Discrepancies Recorded (Principle III)

1. **Tables.** `ERP_GENOME.md` says 54 tables. Reconciled from all 100 migrations in journal order:
   - 54 were ever created;
   - **1 was intentionally dropped** (`party_balances`, `0038`);
   - **53 are live** (50 in Drizzle + 3 raw-SQL-only).

   The SQLite baseline reproduces the 53 live tables. The genome's count is superseded and is not used.
2. **Relationships.** `ERP_GENOME.md` says 86 relationships, which equals the 86 Drizzle `.references()` declarations. The live database
   enforces **73** FKs:
   - 62 that Drizzle declares, plus 11 that exist only in raw SQL;
   - **24 Drizzle-declared `tenant_id → tenants` references are not enforced** (never created by `0001`).

   SQLite reproduces exactly the 73. The 24 stay logical relationships enforced by tenant predicates
   ([data-model §1.0–1.2](./data-model.md)).
3. **Effective vs declared schema.** Some migrations did not apply as written (e.g. a skipped
   `CREATE TABLE IF NOT EXISTS`, repaired by `20261021`). The schema source is the result of applying all migrations in order
   (fingerprint), never individual files or older documentation.
4. **Spec wording.** Corrected on 2026-10-03: FR-007/FR-008 now state the 53 live tables and 73 enforced FKs and the 3
   raw-SQL-only tables, and `party_balances` is described as historically dropped.
5. **Backup exclusion set.** The v2 `DEVICE_BOUND_TABLES` excludes `licenses` entirely, which conflicts with BK-2/FR-042. v3 uses
   the split rule in research R10: keep the company licence identity, null its four device-bound columns, exclude
   device-bound tables including `license_audit_events`, and carry the live device-bound state over on restore.
6. The spec says "SYP/USD". The schema also allows `eur` (CHECK constraints). The parity scenarios include EUR so nothing is
   dropped.

## Implementation Order (small, reviewable stages)

| Stage | Content | Exit criterion | Rollback / safety |
|---|---|---|---|
| **S0** Baseline | **First** apply the approved pre-reference defect fixes (FR-070) to the PostgreSQL behavior: D-4 (backend list defaults + frontend operational lists/pickers; by-id lookups unchanged) after the I-15 audit of every list path, plus track P (pagination/history completeness and the D-3 error + Retry state). Verify them on PostgreSQL, including the cloud image. No other cloud behavior change. **Then** freeze and hash the reference PostgreSQL desktop build. Resolve I-13. Build the parity harness and scenarios, including the cancelled-record checks. Record reference outputs. Track P lands; re-take the AC-9 baseline. | Reference snapshots committed; track P merged and verified on PostgreSQL | No production change. Track P has its own rollback. |
| **S1** Port extraction | **Blocked by I-16** (T015). Move the ~25 non-repository *query* files behind ports, and repoint the ~15 *transaction-only* routes to the engine-neutral transaction facade (measured 2026-10-03; authoritative list from I-16). Add `DB_ENGINE` selection (postgres only). | The full PostgreSQL suite and e2e are green and the cloud image's behavior is unchanged | Pure refactor; revert the commit range. The cloud deploy is gated on the green suite. |
| **S2** SQLite schema | sqlite-core schemas, custom types (money/time/bool/json/uuid), `0000_baseline.sql` reproducing the **53 live tables and 73 enforced FKs** (no `party_balances`, no added tenant FKs), triggers T1–T7, fingerprint and comparison script (I-4, I-8). | Fingerprint comparison shows only the allowed deltas (data-model §1); trigger unit tests pass | Not wired into the app; delete the folder |
| **S3** Connection layer | Writer gate, reader, ambient tx, savepoints, tx clock, PRAGMAs, error mapping, native addon packaging (I-1, I-2, I-6). | Conformance tests for tx/locking/errors pass; kill test on the bare layer passes | Behind `DB_ENGINE=sqlite`, which is off by default |
| **S4** Repositories (batches) | 4a parties/users/settings → 4b inventory → 4c invoices + ledger + cash box → 4d vouchers/returns/settlements/expenses/print → 4e year close/purge/merge → 4f licensing/setup/installation (I-3, I-5, I-7, I-10) | Each batch: the engine conformance tests for its ports plus the parity scenarios for its domain have an empty diff | Each batch is a separate PR; the desktop still ships the PostgreSQL build |
| **S5** Search | LIKE/ESCAPE helper; Arabic/Latin corpus parity; measure at 100k (FTS5 prefilter only if the gate fails). | Identical result sets | Prefilter optional and removable |
| **S6** Backup v3 | `createAndVerify` for all paths (including the pre-migration snapshot), split licence exclusion rules + restore carry-over of device-bound state (research R10, I-18), registry, retention 7 + mirror, restore staging, RS-5 compare, weekly restore-test. Native save on the desktop only; the web keeps its existing download (I-11). | quickstart §5 passes on a developer machine | v2 remains for cloud; the desktop is still on PostgreSQL in releases |
| **S7** Runtime | Rust: remove PostgreSQL boot, ports and pgdata; `data_lock.rs`; startup state machine + UI screens (PRIOR_DATA_FOUND offers Open existing / Restore / Start new); install-instance marker in the NSIS `POSTINSTALL`/`PREUNINSTALL` hooks + update hand-off token (D-1, I-14); connection info; restart bound 3/5 min; per-user install-id (D-2). Update flow (LC-4): a VERIFIED pre-update backup, then a graceful backend stop with `wal_checkpoint(TRUNCATE)`, then lock release, apply the update, and relaunch on the same `data_id`. A failed or timed-out shutdown is reported as such and never treated as corruption. | quickstart §4 negative cases pass on a developer VM | Built behind a Cargo feature until S9; the PostgreSQL runtime stays selectable for internal builds |
| **S8** Sync on SQLite | Device sync tables on SQLite; golden wire test; A/B convergence; restore-on-synced flow (I-9, I-12). | quickstart §6 passes against the PostgreSQL hub | Hub untouched; fall back by not enabling the SQLite build |
| **S9** Packaging | Remove PostgreSQL from resources, manifest, installer and template build; ship the addon; AC-1 inspection. | quickstart §8 passes on the packaged build | Previous PostgreSQL release remains downloadable. **Downgrade from a SQLite install to a PostgreSQL build is unsupported**: the PostgreSQL build would see no `pgdata` and refuse with DATA_MISSING, never touching `motard.db`. |
| **S10** Volume | 100k gate and 1M soak on SQLite against the PostgreSQL baseline. | OQ-4 targets met; completeness 100% | Index or prefilter additions only |
| **S11** Acceptance | The full §10.1 protocol on Windows 10 22H2 and Windows 11 with the hashed final EXE; all AC-1…AC-12 PASS reports; release report states the U-1/U-2 status. | All gates PASS | Do not ship on any FAIL |

**Ordering rationale** (PRD §11):
- baseline first (S0)
- investigate before designing (Investigation Items scheduled before their stage)
- clean SQLite start (S2–S4)
- lifecycle rework (S6–S7)
- parity, sync, backup and volume (S4–S10)
- EXE protocol last (S11)

## Release Blockers (any one ⇒ no release; Principle X, FR-066)

- Any non-empty parity diff (AC-3) on any scenario, including `cashbox_daily_balances`.
- Any data loss, partial operation or corruption in the durability, lifecycle or crash tests.
- Any wrong-company or wrong-database open, silent new database, or automatic deletion (AC-10).
- Any backup reported successful that is not VERIFIED, or any restore with a non-zero RS-5 difference.
- Any sync divergence, lost operation, or re-pushed acknowledged unit (AC-8).
- Any PostgreSQL binary or process, local listening port, or `db-port.txt` in the packaged build (AC-1).
- An OQ-4 target missed at the 100k gate, or history truncated (AC-9).
- The tested EXE hash differs from the shipped EXE hash.
- U-1 or U-2 status not stated in the release report.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Parallel `Sqlite*Repository` family (~34 classes) duplicating `Postgres*Repository` | Keeps the cloud code path untouched (FR-006) and makes per-port parity testable | Dialect-neutral rewrite would change cloud SQL and widen regression risk |
| Approved pre-reference defect fixes (D-3, D-4, track P) change shared/cloud behavior | Owner-approved fixes of PRD defects P-5/P-8 (spec FR-070). Applied before the reference freeze so parity compares corrected behavior. | Leaving the defects would make a known defect the parity reference (rejected by D-4). Fixing them only on the desktop would split behavior between editions. |
| S1 touches shared use-case/route files (~25 query files moved behind ports, ~15 tx-only routes repointed) | Without a port, those files cannot run on SQLite at all | Leaving SQL in use cases would force engine conditionals into business code (Principle IX) |
| Money stored as scaled INTEGER in SQLite, despite `docs/money-representation.md` ("no integer minor units") | The only exact-sum representation SQLite offers. Scaling is storage-only; app code still sees the same `number` values. | `REAL` drifts (the documented failure). Decimal TEXT needs custom aggregates everywhere and breaks numeric ordering. |
| New UI states (startup states, backup VERIFIED/FAILED, desktop-only native save, list-load error + Retry) | Required by PRD ID-5/6/7, RT-4/6 and BK-7, and by D-3 (FR-068). The web keeps its existing backup download. | No alternative meets those requirements |
| `motard_meta`, `motard_sequences` and TEMP `motard_session_flags` added to the schema | Data identity (ID-3) and replacements for PostgreSQL sequences and GUCs | Sidecar-only identity can be separated from the database file; a GUC equivalent does not exist in SQLite |
