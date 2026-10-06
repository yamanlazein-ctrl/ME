<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (MINOR: one narrow, explicit exception added; no principle removed
  or redefined)
- Modified principles:
  I.  Desktop Engine Boundary: SQLite Only, No Local Server, No Local Port (title unchanged): adds the
      approved pre-reference defect-fix exception to the cloud-behavior rule
  IX. Preserve Domain Logic; Change Only What the Engine Forces (title unchanged): adds the same
      exception to the "screens and workflows stay as they are" rule
- Modified sections: Scope & Technical Boundaries: the out-of-scope cloud bullet now names the exception
- Added sections: none
- Removed sections: none
- Exception scope: only D-3 (failed-list error with Retry), D-4 (cancelled customers/suppliers hidden
  from operational lists) and Track P (pagination/history completeness), applied on PostgreSQL before
  the reference build is frozen (spec FR-070). No other cloud behavior may change.
- Templates requiring updates: none.
- Deferred TODOs: none.
- Sources: docs/PRD-DESKTOP-SQLITE.md; specs/001-desktop-sqlite-engine/spec.md (FR-068–FR-070).
-->

# Motard Desktop (PostgreSQL → SQLite) Constitution

## Core Principles

### I. Desktop Engine Boundary: SQLite Only, No Local Server, No Local Port

- The desktop build MUST use embedded SQLite as its only database (DB-1). It MUST NOT ship,
  bundle, launch, supervise, or depend on `postgres.exe`, `pg_ctl`, `initdb`, `pg_dump`,
  `pgdata`, or any other PostgreSQL server binary or data directory.
- The desktop MUST NOT open, listen on, or connect to any local TCP port for database access, and
  MUST NOT create or read `db-port.txt` (RT-1, LC-8). Frontend ↔ backend traffic stays on the
  Named Pipe / IPC.
- The Supervisor and Windows Job Object MUST be limited to backend (Node) lifecycle: preventing
  orphaned or hung processes. All database-server lifecycle logic MUST be removed (RT-3).
- Node/Express remains an internal, Tauri-managed process that is invisible to the user (RT-2).
- The cloud backend, admin dashboard, and central sync server stay on PostgreSQL and MUST NOT be
  changed in behavior by this project. Where one backend codebase serves both cloud and desktop,
  the PostgreSQL code path MUST remain behaviorally identical (PRD §3, OQ-9).
- **Sole exception: approved pre-reference defect fixes.** The owner-approved fixes D-3 (failed list
  load shows an error with Retry), D-4 (cancelled customers and suppliers hidden from operational
  lists) and Track P (pagination and history completeness) MAY change shared and cloud behavior on
  PostgreSQL. They MUST be applied and verified before the PostgreSQL reference build is frozen
  (spec FR-070). These are the only approved shared or cloud behavior changes in this project.
  Nothing else in the cloud may change.

Verification: the packaged EXE is inspected for absence of PostgreSQL binaries and `db-port.txt`,
and a running instance is checked for zero listening database ports (AC-1, AC-2).

### II. Behavioral & Accounting Parity (NON-NEGOTIABLE)

- The current PostgreSQL desktop build is the reference oracle (C-1). For the same inputs, the
  SQLite build MUST produce identical calculations, balances, account statements, ledger entries,
  cash-box movements, stock movements, currency/exchange-rate results, and relationships.
- Any difference in accounting meaning or financial result is a defect. It is never an accepted
  "engine difference" (C-1, C-2, C-3).
- Existing behaviors MUST keep their logic and results: party deletion, purge cascades (party and
  dye), party merge, financial-year close and reopen, inventory counts, settlements, and
  cancellation of invoices, vouchers, and returns (C-5).
- Monetary values MUST keep exact decimal semantics, including rounding. Storing or computing money
  as binary floating point where PostgreSQL uses exact numerics is prohibited.
- Every PostgreSQL-specific mechanism the backend relies on MUST be inventoried before the SQLite
  design is finalized (DB-7). Each one MUST be reproduced with identical observable behavior and
  covered by a parity test. This includes triggers (for example the ledger and license-audit
  append-only guards, the cash-box daily-balance triggers, and the sync-inbox `applied_seq`
  stamping), row-level security, row locking (`FOR UPDATE`), `ON CONFLICT`, `RETURNING`,
  sequences, and trigram search. Dropping a mechanism's effect without an equivalent is a
  violation.
- Parity MUST be proven by running the same scenarios on both builds and comparing outputs
  (AC-3). Code reading alone is not proof.

### III. Complete Schema, Relationships & History

- The SQLite schema MUST support every table, relationship, and function the system relies on:
  54 tables and 86 relationships per `ERP_GENOME.md` (DB-2). No table, column, constraint,
  foreign key, or index may be dropped because current data is test data (C-7).
- The schema source of truth is the effective PostgreSQL schema: Drizzle schema files plus raw-SQL
  migrations, not Drizzle alone. Tables that exist only in migrations (for example
  `financial_operations`, `party_balances`, `sync_conflicts`, `sync_tombstones`) MUST be included.
  Any disagreement between the genome and the code MUST be resolved against the migrations and
  recorded.
- Referential integrity MUST be enforced at runtime on every connection, with the same
  cascade/restrict meaning as today (C-4).
- `cancelled` status semantics MUST hold in every list and lookup path, so cancelled or deleted
  records never appear as active (P-5).
- The role of `ledger_entry_archive` MUST be established from evidence before the storage design is
  finalized (DB-6, OQ-7). Whatever is decided, the full ledger history MUST remain reachable in
  statements, reports, and audit.

### IV. Atomic & Durable Financial Writes (NON-NEGOTIABLE)

- Every operation that affects several records (for example invoice + lines + ledger + cash
  and/or stock movement) MUST run in a single transaction. It is fully committed or fully absent
  (C-9, DB-4).
- A write MUST be reported to the user as successful only after it is durable. It MUST survive
  power loss, Windows crash, and backend crash (C-10, DB-5).
- SQLite journal and sync settings that trade durability for speed (for example `synchronous=OFF`,
  `journal_mode=OFF` or `MEMORY`) are prohibited. The chosen settings MUST be proven by
  crash, force-kill, and power-loss tests.
- Concurrency guarantees provided today by PostgreSQL locks MUST be preserved: no double
  allocation of roll stock or document numbers, and no lost updates under optimistic concurrency
  control (OCC).

### V. No Artificial Limits on Data or History

- No `LIMIT`, page cap, loop bound, or silent truncation may prevent a user from reaching their
  data (C-11). There is no product-level maximum data volume (DA-1).
- Performance MUST be achieved through schema design, indexes, keyset pagination, and correct
  queries. It is never achieved by hiding data (DA-6).
- Year close MUST NOT hide or replace prior-year detail. Summaries may exist, but never instead
  of the original movements (DA-4). Any archiving MUST be transparent to the user and use the
  same calculation logic (DA-5).
- Customer statements MUST show complete detailed history with correct opening balances (DA-3).
- Test volumes are measurement sizes, not product limits (§10.2). Known existing caps (for
  example the 1000-page bound in `src/presentation/hooks/useStatement.ts`) are fixed on the
  separate pagination track (§5.3). Full history access is still a release gate (AC-9).

### VI. Data Identity & Safe Lifecycle (NON-NEGOTIABLE)

- The system MUST NEVER automatically delete, replace, or silently open pre-existing data, and
  MUST NEVER silently create a substitute database (C-13, AC-10).
- The database lives in a fixed per-Windows-user AppData location, independent of the EXE path and
  of removable drives (ID-1, ID-2). Uninstall MUST preserve the database and backups (C-12,
  LC-6).
- "Update of the same installation" versus "new installation" MUST be decided from installation
  identity and data identity together. It MUST never be decided from a port or the presence of a
  single file (ID-3).
  - When the same installation is proven, the app reuses the database (ID-4).
  - When a new installation finds prior data, the user makes an explicit choice (ID-5).
  - Existing, mismatched, corrupt, and previous-data states are each presented distinctly, with
    open/restore/new options (ID-6).
- The app MUST be able to show which database file, data root, and tenant it is connected to
  (ID-7). A clean first install contains no prior data (ID-8, AC-11).
- Technical runtime state MUST be stored separately from business data (DB-3).
- Only one normal instance per installation may run (RT-5).
- A locked database file is handled as follows (RT-6):
  - Nothing is deleted or replaced.
  - A stale process from the same installation is awaited or terminated safely.
  - When the lock holder is unknown, startup halts with a clear state, and the database is
    neither declared corrupt nor replaced.
- Backend crashes trigger a bounded silent restart, then a clear "internal service stopped"
  message that never claims database corruption (RT-4).
- An update MUST follow: save → safe close → apply → relaunch on the same database. It MUST never
  replace or create a database. A failed shutdown is not corruption (LC-4). Updates after years
  continue on the same data through forward schema migration (LC-5, DB-9).
- No legacy PostgreSQL-data migration code may be introduced in this phase. The new build starts
  from a clean SQLite database (DB-8).
- Tools, scripts, and tests MUST NOT delete or reset a real data directory or database file without
  an explicit, deliberate user confirmation.

### VII. Verified Backup & Restore

- A backup is a complete company backup (BK-1): all business and accounting data, attachments,
  company settings, and the license information that identifies the copy. Device secrets and
  device binding MUST be excluded (BK-2).
- A backup MUST be marked VERIFIED only after validation passes (BK-6, BK-7):
  - the archive is intact
  - all required files are present
  - the SQLite database opens
  - `integrity_check` passes
  - metadata matches

  Producing a file is not success. Backup files MUST be written atomically, so a partial file is
  never presented as a backup.
- Manual backup, automatic pre-operation backup (update, restore, year close/reopen, purge, merge,
  bulk-impact operations), and periodic background backup MUST exist (BK-3, BK-4, BK-5).
- Restore MUST work on the same device and on a new device (RS-1). It MUST follow these steps
  (RS-3, RS-6):
  1. Take an automatic backup of the current state.
  2. Copy the backup.
  3. Migrate the copy.
  4. Verify the copy.
  5. Open it.

  The original backup MUST NEVER be modified.
- Incompatible or incomplete backups MUST be rejected clearly. A partial database is never opened
  (RS-4).
- After restore, the result MUST be compared against the source (RS-5): record counts, parties,
  invoices, balances, ledger, inventory, cash box, and statements.

### VIII. Offline-First Sync Fidelity (SQLite ↔ Central PostgreSQL)

- Every device MUST work fully offline with no artificial time limit (SY-2).
- The existing sync mechanism MUST move to SQLite unchanged in principle and data meaning (SY-1).
  This covers:
  - `sync_outbox` / `sync_inbox`
  - tombstones
  - per-device document-number blocks
  - resource claims
  - OCC
  - the keep-server / rebase / withdraw conflict decisions
- Sync scope MUST NOT shrink or grow because of the engine change. Current exclusions stay
  excluded (SY-5).
- Payloads exchanged with the central PostgreSQL server MUST be wire-compatible with what the
  PostgreSQL desktop build emits today, including decimal, timestamp, boolean, UUID, and JSON
  representations.
- After sync and conflict resolution, all devices and the server MUST converge on identical business
  state: invoices, document numbers, parties, balances, ledger, inventory, and cash box (SY-3).
  No silent overwrite and no lost operation (SY-4).
- Restore on a synced device MUST follow these steps (SY-6):
  1. Detect the older snapshot.
  2. Pause sync.
  3. Inform the user.
  4. Reconcile before resuming.

  It MUST NOT delete newer operations, erase server history, republish old operations as new, or
  let the server blindly "add what is missing" (SY-7).

### IX. Preserve Domain Logic; Change Only What the Engine Forces

- This is an engine replacement, not a redesign (§5.2). Changes MUST be confined to persistence
  and runtime layers: ORM/schema, migrations, repositories, backup/restore, installation identity,
  and the desktop runtime/supervisor.
- Domain entities, use-case business rules, API route contracts, screens, workflows, activation,
  and licensing MUST stay as they are (C-6, C-8). Where SQLite technically forces a change outside
  the persistence layer, the plan MUST justify it explicitly and prove that results are unchanged.
- The only exception to the rule above is the approved pre-reference defect fixes defined in
  Principle I (D-3, D-4, Track P). They may change the affected screens' list behavior as specified,
  and nothing else.
- Opportunistic refactors, renames, formatting sweeps, and "while we're here" rewrites are
  prohibited in this project's changes.
- `ERP_GENOME.md` is the first navigation map for locating structures. Its claims MUST be verified
  against the code before being relied on for a design decision. Targeted repository investigation
  is preferred over indiscriminate reading.

### X. Packaged EXE Is the Release Truth; Gate Failures Block Release

- Every release gate AC-1 through AC-12 MUST be executed against the final packaged Windows EXE,
  using the §10.1 lifecycle protocol on a clean real or virtual Windows machine (AC-12). The
  protocol stages are:
  1. install
  2. first run
  3. create data
  4. close/reopen
  5. crash/force-kill
  6. Windows restart
  7. update
  8. uninstall
  9. reinstall
  10. backup
  11. restore
- Code reading, unit tests, or `cargo test` alone MUST NOT be accepted as passing any gate.
- The EXE that was tested MUST be byte-identical to the EXE that is shipped (P-7).
- A single FAIL in any of the following classes blocks release regardless of other results:
  - data loss or corruption
  - accounting or financial mismatch against the PostgreSQL reference
  - wrong-company or wrong-database opening, or a silent substitute database
  - an unverified backup, or a failed or incomplete restore
  - sync divergence or a lost operation
  - any PostgreSQL binary, process, or local database TCP port in the packaged build
- If U-1 (customer found but list empty) or U-2 (invalid backup root cause) is unresolved at
  release, the release report MUST state so explicitly. Neither may be assumed fixed by the engine
  change.

## Scope & Technical Boundaries

- **In scope** (PRD §5.1):
  - the desktop-local engine swap
  - removing PostgreSQL lifecycle from the desktop runtime
  - first-run, reinstall, update, backup, and restore rework
  - installation and data identity
  - verified backup and restore
  - end-to-end sync re-test
  - PostgreSQL ↔ SQLite parity proof
  - EXE lifecycle acceptance
- **Out of scope** (PRD §5.2):
  - business, accounting, screen, or workflow redesign
  - any change to the cloud backend, admin dashboard, or central sync server, except the approved
    pre-reference defect fixes D-3, D-4 and Track P (Principle I)
  - migration of existing PostgreSQL data
  - changing sync scope
  - user-chosen database locations
- **Separate track:** the pagination and silent-limit fixes (§5.3) are not merged into this
  project's implementation, but AC-9 completeness is still required for release.
- **Open decisions:** OQ-1 through OQ-12 (for example restart bounds, the backup compatibility
  window, retention, volume targets, and supported Windows versions) are owner decisions.
  Specs and plans MUST mark them `[NEEDS CLARIFICATION]` and MUST NOT silently pick a value.
- **Authoritative sources:** `docs/PRD-DESKTOP-SQLITE.md` for requirements, `ERP_GENOME.md` for
  the structural map, and the repository code and migrations for implementation facts.

## Development Workflow & Quality Gates

- **Sequencing** (PRD §11):
  1. Establish the PostgreSQL baseline: parity reference results and data completeness.
  2. Investigate `ledger_entry_archive` and inventory the PostgreSQL-specific behaviors.
  3. Build on a clean SQLite database.
  4. Rework the lifecycle flows.
  5. Run the parity, sync, backup/restore, and volume tests.
  6. Run the full EXE lifecycle protocol.

  A design MUST NOT be finalized before step 2 is complete.
- **Evidence over assertion:** every claim that something works, is fixed, or is unchanged MUST be
  backed by an executed test or reproducible evidence. Unknowns stay labelled UNKNOWN until proven.
- **Constitution Check:** every `/speckit-plan` MUST map its design to Principles I–X and list any
  deviation in Complexity Tracking with justification.
- **Persistence changes:** any change touching persistence, transactions, or financial flows MUST
  include or extend a parity test against the PostgreSQL reference.
- **Failure handling:** every lifecycle and failure scenario MUST meet the PRD §8 Failure-Handling
  Matrix. The "forbidden behavior" column is a list of defects.
- **Review:** reviews MUST check for the following and reject a change that contains any of them:
  - introduced caps or limits (V)
  - non-atomic multi-record writes (IV)
  - silent database creation, deletion, or replacement (VI)
  - unjustified changes outside the persistence and runtime layers (IX)

## Governance

- This constitution governs engineering decisions for the PostgreSQL → SQLite desktop project
  and supersedes conflicting practice. It is derived from `docs/PRD-DESKTOP-SQLITE.md`. If the two
  conflict, work stops until the owner amends one of them explicitly. Implementers MUST NOT choose
  between them.
- **Amendments:** an amendment requires a written change, the owner's approval, a semantic version
  bump, and an updated Sync Impact Report. The version bump follows these rules:
  - MAJOR: a principle is removed or redefined.
  - MINOR: a principle or section is added or materially expanded.
  - PATCH: clarifications only.
- **Non-waivable:** Principles II, III, IV, VI, VII, and X cannot be waived for a single feature
  or release. Other deviations require documented justification and owner sign-off in the plan's
  Complexity Tracking.
- **Compliance:** every spec, plan, task list, and review MUST be checked against this
  constitution. Release readiness is defined solely by Principle X and PRD §10.3.

**Version**: 1.1.0 | **Ratified**: 2026-10-03 | **Last Amended**: 2026-10-03
