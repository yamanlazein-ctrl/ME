# Feature Specification: Desktop Local Database Replacement (PostgreSQL → SQLite)

**Feature Branch**: `001-desktop-sqlite-engine` (spec directory; no git branch was created — work
currently sits on `clean-desktop-release`)

**Created**: 2026-10-03

**Status**: Draft

**Input**: User description: "Create the specification for the existing Motard ERP desktop database
replacement, derived from docs/PRD-DESKTOP-SQLITE.md (authoritative), ERP_GENOME.md (architecture
map) and .specify/memory/constitution.md (principles). Preserve all accounting behavior, business
tables and relationships, SYP/USD behavior, offline operation and local ↔ central sync. Cover schema
parity, PostgreSQL-specific behavior, transactions and durability, history completeness, installation
and data identity, lifecycle, backup/restore, sync compatibility, packaged-EXE acceptance and
release-blocking criteria. Keep unresolved PRD open questions marked [NEEDS CLARIFICATION]."

**Traceability**: Requirement IDs in parentheses (e.g. `C-1`, `DB-7`, `AC-3`) refer to
`docs/PRD-DESKTOP-SQLITE.md`. Roman numerals (e.g. `Principle VI`) refer to the constitution.

## Context

Motard's Windows desktop edition currently runs a full PostgreSQL server on the customer's machine,
started and supervised by the desktop runtime, reached over a local TCP port. That server surface
(process lifecycle, port, `pg_ctl`, `pgdata` reuse, installation metadata) has produced reproduced
failures: stale data reused after reinstall (P-4), a cancelled record shown in a list (P-5), an
invalid backup reported as created (P-6), and build artifacts differing from the shipped EXE (P-7).

This feature replaces only the **desktop-local** database engine with an embedded, single-file
database, so the product behaves like a normal Windows application, and closes each previously
observed failure class with its own acceptance gate. The cloud backend, admin dashboard and central
sync server stay on PostgreSQL and are unchanged. Accounting meaning, business rules, screens,
activation, licensing and sync behavior stay the same; any difference in a financial result between
the current build and the new build is a defect (C-1).

## Clarifications

### Session 2026-10-03

Owner decisions (PRD §12):

- Q: OQ-1 — Which Windows versions are supported? → A: 64-bit Windows 10 22H2 and Windows 11; the
  §10.1 lifecycle protocol runs on both.
- Q: OQ-2 — Backend restart bound? → A: at most 3 silent restarts within a rolling 5-minute window;
  the next crash in that window stops retries and shows "internal service stopped".
- Q: OQ-3 — Backup compatibility window? → A: every backup produced by any SQLite-era version (from
  the first SQLite release onward) restores on any newer version, migrated forward on a copy.
  PostgreSQL-era backups are out of scope (DB-8) and are rejected with a clear message.
- Q: OQ-4 — Test volumes and targets? → A: release gate at 100,000 invoices, 200,000 ledger rows and
  10,000 parties: list screens and the first page of a statement under 2 s; a complete single-party
  statement under 10 s. An additional informational soak run at 1,000,000 invoices (not a gate).
- Q: OQ-5 — Periodic backup schedule, retention, location? → A: daily — at startup when the newest
  automatic backup is older than 24 h, and every 24 h while the app is open; keep the 7 newest
  automatic backups; stored in `%LOCALAPPDATA%\motard-erp\backups` with a mirror copy under the
  user's Documents folder; both survive uninstall.
- Q: OQ-6 — Restore-test frequency? → A: weekly, the app silently restores its newest automatic
  backup into a temporary location and runs the RS-5 comparison; additionally, every release gets a
  manual restore on a clean VM.
- Q: OQ-11 — Pagination track timing/scope? → A: it lands before SQLite acceptance testing begins
  and covers every capped "load all" path — the 1000-page statement cap and every fetch-all page
  limit (including the 200-page party-list limit). AC-9 is then run on the SQLite build.
- Q: OQ-12 — Restore on a synced device? → A: newer server operations re-download automatically;
  review mode opens only when local changes made after the restore conflict with them. Sync stays
  paused until reconciliation completes.

Repository findings (investigated 2026-10-03; recorded, not re-asked):

- OQ-7: `ledger_entry_archive` has no runtime readers or writers; year close writes
  `yearly_party_summaries` and never moves ledger rows (ledger deletes are blocked by the append-only
  guard). The table is kept for schema parity; full history lives in `ledger_entries`.
- OQ-8: U-1 — the party list is a client-side cache whose load failures (including exceeding the
  200-page fetch-all limit) leave an empty list with no visible error, while search queries the
  server directly; dev and release builds use different data roots. Which mechanism caused the
  original incident is not established. Cancelled parties are returned by the party list (no default
  status filter) and shown under "all" — the P-5 class is still present for parties. U-2 — only the
  server copy of a manual backup is verified; automatic backups, the pre-restore safety copy and
  pre-operation snapshots are never verified, backup files are not flushed to disk before being
  reported complete, and the manual download reports success before the saved file is confirmed. The
  specific incident's cause is not established.
- OQ-9: one backend codebase and one entry point serve desktop and cloud, switched at runtime by the
  desktop environment flags; all database access is PostgreSQL-specific (shared pool, row-level
  security tenant context, ~98 files coupled to the ORM module). How to split engines is a planning
  decision.
- OQ-10: identity today = DPAPI device binding (per user/PC) + data stamp (`db-meta.json`) + cluster
  marker in the data directory; a separate backend installation ID lives machine-wide in
  `%ProgramData%\ERP\install-id`. Uninstall keeps the data root, so a same-user reinstall silently
  reuses the old database; foreign/copied/mismatched data is refused with a message but no
  open/restore/new choice; the connection display does not show the tenant.

Owner decisions on the findings (final, 2026-10-03):

- **D-1**: a new installation that finds existing company data offers **Open existing data / Restore a
  backup / Start a new project**. It never reuses the data silently. A normal application update reuses the
  existing data automatically (FR-028, FR-029).
- **D-2**: on the desktop, the backend installation identity is **per Windows user** and linked to the desktop
  installation identity (FR-069).
- **D-3**: a list that fails to load shows a clear error with **Retry**. It never shows a false empty state
  (FR-068).
- **D-4**: cancelled customers and suppliers are hidden from normal operational lists, including the default "all"
  view, and preserved for audit and history (FR-017).
- **Approved pre-reference defect fixes**: the D-3 and D-4 fixes and the pagination/history-completeness fixes
  (§5.3) are explicitly approved defect fixes. They are applied to the existing PostgreSQL behavior, in shared code,
  **before** the parity reference is frozen. They are the only behavior changes this work makes to shared or cloud
  code paths. No other cloud behavior changes are permitted (FR-070).

## User Scenarios & Testing *(mandatory)*

Actors: **Store user** (owner/accountant/warehouse/viewer roles working in the desktop app),
**Installer/updater** (the person installing, updating, uninstalling or reinstalling the app),
**Multi-device operator** (a business running several synced desktops), **Release owner** (decides
whether a build ships).

### User Story 1 - Same accounting results on the new engine (Priority: P1)

A store user does their normal daily work — sells and buys fabric on invoices, receives and pays
vouchers in SYP and USD, records returns, settles invoices, moves stock between rolls, closes the
cash box day, merges or purges parties, closes and reopens a financial year — and every number,
balance, statement and relationship comes out exactly as it does on today's PostgreSQL build.

**Why this priority**: The project's only acceptable outcome is "the same ERP on a simpler engine".
A single financial difference makes the build unshippable (C-1, AC-3), so parity is the foundation
every other story depends on.

**Independent Test**: Run one scripted scenario set on the current PostgreSQL build and on the
SQLite build from identical clean starting states; compare calculations, balances, account
statements, ledger, inventory, cash box and relationships field by field. Any difference fails.

**Acceptance Scenarios**:

1. **Given** identical clean companies on both builds, **When** the same sequence of customers,
   suppliers, sales/purchase invoices, receipt/payment vouchers, returns, settlements and
   cancellations is applied, **Then** every party balance, account statement line, ledger entry,
   cash-box balance per currency and stock quantity is identical on both builds.
2. **Given** transactions in both SYP and USD with exchange rates, **When** balances, statements and
   cash box are computed, **Then** amounts, rounding and exchange-rate meaning are identical to the
   PostgreSQL build.
3. **Given** a party with invoices, vouchers, returns and ledger history, **When** the party is
   merged into another, or purged with cascade, or a dye (fabric) is purged with cascade, **Then**
   the surviving records, rebuilt balances and cash-box series are identical to the PostgreSQL
   build.
4. **Given** a financial year with activity, **When** the year is closed and then reopened, **Then**
   yearly summaries, opening balances and the visible prior-year detail are identical to the
   PostgreSQL build.
5. **Given** an invoice, voucher or return that has been cancelled, **When** any list, search or
   picker that shows active records is opened, **Then** the cancelled record is not shown as
   active (P-5).

---

### User Story 2 - A normal Windows app with no database server (Priority: P1)

A store user installs Motard, opens it, works, and closes it like any other Windows program. There
is no database service, process, port or port file to know about, start, stop or troubleshoot.

**Why this priority**: Removing the server runtime surface is the reason the project exists (PRD
§2.3); it is a release gate (AC-1, AC-2).

**Independent Test**: Inspect the packaged installer/EXE and a running instance on clean Windows:
no PostgreSQL binaries, no database process, no listening local database port, no `db-port.txt`.

**Acceptance Scenarios**:

1. **Given** a clean Windows machine, **When** the app is installed and opened, **Then** it works
   directly and no database service or console window is visible (LC-1, RT-2).
2. **Given** the app is open, **When** local listening ports and running processes are inspected,
   **Then** no local database port and no PostgreSQL process exist (RT-1, AC-1).
3. **Given** the app is open, **When** the user closes it, **Then** it exits completely with no
   leftover background process (LC-2, RT-3).
4. **Given** the app is already running, **When** the user launches it again, **Then** the existing
   instance keeps the session and no second normal instance starts (RT-5).
5. **Given** the internal backend crashes while the app is open, **When** the failure is transient,
   **Then** it restarts silently; **When** the restart bound is reached, **Then** restarts stop and
   the user sees a clear "internal service stopped" message that does not claim the database is
   corrupt (RT-4).

---

### User Story 3 - The same company data across the whole app lifecycle (Priority: P1)

An installer/updater restarts Windows, updates the app (including after one to four or more years),
uninstalls it, and reinstalls it. Each time, the app opens the same company with the same history,
never silently opens a different company, never silently starts empty, and never deletes data on its
own. When a fresh install finds earlier data, the user is asked what to do.

**Why this priority**: The most damaging past failure was stale data reused after reinstall (P-4),
and apparent "data loss" cases turned out to be the wrong data root or hidden data (U-1). Opening the
wrong database is release-blocking (AC-6, AC-10, AC-11).

**Independent Test**: Run the §10.1 lifecycle protocol on a clean VM with realistic data, recording
record counts and balances after each stage; they must be unchanged, and every "prior data found"
or "mismatch" situation must produce an explicit user choice.

**Acceptance Scenarios**:

1. **Given** a clean first install, **When** the app opens for the first time, **Then** it contains
   no prior data, settings or database (ID-8, AC-11).
2. **Given** a company with data, **When** the app is closed and reopened, crashed, force-killed, or
   Windows is restarted, **Then** the same data is present and every save the user saw confirmed is
   still there (LC-3, AC-5).
3. **Given** a company with data, **When** the app is updated while running, **Then** state is
   saved, the app and internal services close safely, the update is applied and the app relaunches
   on the same database; no database is replaced or newly created (LC-4).
4. **Given** a company with data created on an old version, **When** the app is updated after a long
   gap, **Then** it continues on the same database and history (LC-5).
5. **Given** a company with data, **When** the app is uninstalled, **Then** the database and backups
   remain on the machine (LC-6, C-12).
6. **Given** a company with data, **When** the app is updated (in-app or by installing a newer version over
   the existing installation without uninstalling), **Then** it reuses the same database automatically,
   with no prompt (ID-4).
7. **Given** a new installation (including a reinstall after uninstall) that finds earlier company data,
   **When** the app opens, **Then** it does not open, delete or replace that data silently; it tells the
   user a saved project exists and requires an explicit choice: **open the existing data, restore a
   backup, or start a new project**. "Start a new project" keeps the earlier data aside, undeleted (ID-5,
   D-1).
8. **Given** a database that is mismatched (belongs to a different installation/company) or corrupt,
   **When** the app opens, **Then** that exact condition is shown distinctly with open/restore/start-
   new options and nothing is deleted automatically (ID-6, C-13).
9. **Given** the app is running, **When** a user or support person asks which data it is using,
   **Then** the app shows the database location, data root and company (tenant) it is connected to
   (ID-7).
10. **Given** the database file is held by another process at startup, **When** that process is a
    leftover of the same installation, **Then** the app waits for it or ends it safely; **When** the
    holder is unknown, **Then** startup halts with a clear state, the database is not called corrupt
    and no new database is created (RT-6).

---

### User Story 4 - Backups that are proven restorable (Priority: P2)

A store user takes a manual backup; the app also backs up automatically before sensitive operations
and periodically in the background. A backup is only reported as good after it has been checked.
The user can restore it on the same machine or on a new machine and gets the same company back.

**Why this priority**: An invalid backup was once reported as created (P-6). Backups are the only
sanctioned way to move data (§5.2) and the safety net for every risky operation; a backup/restore
failure is release-blocking (AC-7).

**Independent Test**: Create a backup from a company with realistic data, confirm it is marked
VERIFIED, restore it on the same device and on a clean device, and compare record counts, parties,
invoices, balances, ledger, inventory, cash box and statements against the source.

**Acceptance Scenarios**:

1. **Given** a company with data, **When** the user takes a manual backup, **Then** the backup is
   marked VERIFIED only after the archive is intact, all required files are present, the database
   opens, the integrity check passes and metadata matches; otherwise it is reported as failed
   (BK-3, BK-6, BK-7).
2. **Given** the user starts an update, restore, year close or reopen, purge, merge, or another
   large-impact operation, **When** the operation begins, **Then** an automatic backup is taken first
   (BK-4).
3. **Given** a VERIFIED backup, **When** it is restored on the same device or a new device, **Then**
   the post-restore comparison against the source matches for record counts, parties, invoices,
   balances, ledger, inventory, cash box and account statements (RS-1, RS-5, AC-7).
4. **Given** a backup made by an older app version within the supported window, **When** it is
   restored on a newer version, **Then** a copy is migrated, verified and opened, and the original
   backup file is never modified (RS-2, RS-3).
5. **Given** an incomplete, corrupt or incompatible backup, **When** restore is attempted, **Then**
   it is rejected with a clear message and no partial database is opened (RS-4).
6. **Given** any backup, **When** its contents are examined, **Then** it includes business data,
   attachments, company settings and the license information identifying the copy, and excludes
   device secrets and device binding (BK-1, BK-2).

---

### User Story 5 - Offline devices that converge after sync (Priority: P2)

A multi-device operator runs two or more desktops that each work fully offline for any length of
time. When they reconnect, each device's work syncs through the central server, conflicts are
resolved by the existing policy, and every device ends with the same business state.

**Why this priority**: Multi-device sync is part of the product and is not yet proven end-to-end
(U-5); a sync divergence or lost operation is release-blocking (AC-8).

**Independent Test**: Device A creates 20 invoices and Device B creates 30 while both are offline,
including edits to the same record and the same roll; after reconnection, sync and conflict
resolution, both devices and the server show the same 50 invoices with identical document numbers,
parties, balances, ledger, inventory and cash box.

**Acceptance Scenarios**:

1. **Given** a device with no internet, **When** the user works for an extended period, **Then** all
   features work locally with no artificial offline time limit (SY-2).
2. **Given** two offline devices with independent work, **When** they reconnect and sync completes,
   **Then** all devices and the server hold the same invoices, document numbers, parties, balances,
   ledger, inventory and cash box (SY-3, AC-8).
3. **Given** both devices changed the same record or consumed the same roll, **When** sync runs,
   **Then** the existing conflict policy (keep-server / rebase / withdraw) resolves it, no operation
   is silently overwritten or lost, and the outcome is identical on every device (SY-4).
4. **Given** the sync scope of today's build, **When** the new build syncs, **Then** exactly the same
   kinds of records sync and today's exclusions stay excluded (SY-5).
5. **Given** a synced device restores an older backup, **When** the restored data opens, **Then** the
   device recognizes it is an older snapshot, pauses sync, informs the user that newer data exists on
   the server, identifies post-backup operations and reconciles safely before sync resumes; it never
   deletes newer operations, erases server history, republishes old operations as new, or lets the
   server blindly add whatever is missing (SY-6, SY-7).

---

### User Story 6 - Complete history, however old and however large (Priority: P3)

A store user opens a customer statement, an old invoice, a stock movement history or the cash box
for any past period — four, ten or more years back — and sees complete detail, with correct opening
balances, regardless of how much data the business has accumulated.

**Why this priority**: History completeness is a constitutional rule (Principle V) and a release
gate (AC-9), but the existing pagination defect is fixed on a separate track (§5.3), so this story
validates rather than drives the engine work.

**Independent Test**: Load a large test volume, baseline statement and history completeness on the
PostgreSQL build, then confirm the SQLite build returns the same complete results with no cap or
truncation.

**Acceptance Scenarios**:

1. **Given** a customer with a very long history, **When** the full statement is opened, **Then**
   every movement since the first one is present with correct opening and running balances (DA-3).
2. **Given** several closed financial years, **When** prior-year detail is requested, **Then** the
   original movements are shown, not only a yearly summary or opening balance (DA-4).
3. **Given** large test volumes, **When** lists, statements and reports are opened, **Then** results
   are complete and match the PostgreSQL baseline (AC-9, DA-6).

---

### Edge Cases

- **Power loss / Windows crash during a multi-record save**: the operation is either fully present
  or fully absent; never an invoice without its ledger, cash or stock movement (C-9, §8).
- **Two launches at once**: only one instance owns the session (RT-5).
- **Stale process from a previous crash holds the database**: wait or terminate safely; never delete
  or replace the database (RT-6).
- **Unknown process holds the database**: halt safe startup with a clear state; never declare
  corruption or create a new database (RT-6).
- **Update shutdown fails**: not interpreted as corruption; data untouched (LC-4).
- **Reinstall where installation identity and data identity disagree**: treated as a mismatch and
  presented to the user, not decided silently (ID-3, ID-6).
- **Another Windows user account on the same PC**: cannot unintentionally open this user's data
  (ID-2).
- **Backup produced but fails validation**: never shown as a successful backup (BK-7).
- **Restore of a backup older than the supported compatibility window**: rejected clearly (RS-4).
- **Restore on a device whose server copy is newer**: sync paused and reconciled (SY-6).
- **Same roll consumed offline on two devices**: resolved by the existing conflict policy with an
  identical result everywhere (SY-4).
- **Statement requested for a party with years of activity**: full history, no truncation (C-11).
- **U-1 situation (a customer is found by search while the customer list is empty)**: the app can
  show which database, data root and tenant it is connected to so the cause can be diagnosed (ID-7);
  the root cause is investigated, not assumed fixed (§9).

## Requirements *(mandatory)*

### Functional Requirements

#### Engine boundary and runtime

- **FR-001**: The desktop build MUST use an embedded, single-file local database (SQLite) as its only
  database; it MUST NOT include, launch or depend on any PostgreSQL server binary, process or data
  directory (DB-1, AC-1).
- **FR-002**: The desktop MUST NOT open, listen on or connect to any local TCP port for database
  access and MUST NOT create or read a port file (`db-port.txt`); local frontend ↔ backend
  communication stays on the existing Named Pipe / IPC (RT-1, LC-8).
- **FR-003**: The internal backend MUST remain an internal process managed by the desktop shell and
  invisible to the user; process supervision MUST be limited to backend lifecycle and MUST prevent
  orphaned or hung processes after crash or force-kill (RT-2, RT-3).
- **FR-004**: After a transient backend crash, the app MUST restart the backend silently up to a
  bounded number of attempts — at most 3 restarts within a rolling 5-minute window (OQ-2); once the
  bound is reached it MUST stop retrying and show an
  "internal service stopped" message that does not claim database corruption (RT-4).
- **FR-005**: Only one normal instance of an installation MUST run at a time (RT-5).
- **FR-006**: The cloud backend, admin dashboard and central sync server MUST remain on PostgreSQL
  with unchanged behavior. Where the same backend code serves both cloud and desktop, the cloud
  path MUST remain behaviorally identical. The sole exception is the approved pre-reference defect
  fixes in FR-070 (D-3, D-4, Track P), applied on PostgreSQL before the reference freeze
  (constitution v1.1.0, Principle I). Finding (OQ-9): one backend codebase and entry point
  serve both today, so the cloud's PostgreSQL behavior MUST be proven unchanged by the engine split;
  the split mechanism is decided in planning.

#### Schema and relationship parity

- **FR-007**: The local schema MUST cover every table, relationship and function the current system
  relies on: the **live** schema of **53 tables and 73 enforced foreign keys**, reconciled from the
  full migration history (`data-model.md` §1.0). No live table, column, constraint, relationship or index
  may be dropped because current data is test data (DB-2, C-7). `ERP_GENOME.md`'s 54 tables / 86
  relationships include one table intentionally dropped by migration `0038` (`party_balances`) and 24
  declared-but-never-enforced `tenant_id → tenants` references. Neither is part of the live schema to
  reproduce.
- **FR-008**: The schema baseline MUST be the effective live schema, meaning the result of applying every
  migration in journal order, so the three tables that exist only in raw SQL migrations
  (`financial_operations`, `sync_conflicts`, `sync_tombstones`) are included. Any disagreement between
  `ERP_GENOME.md` and the code MUST be resolved against that result and recorded.
- **FR-009**: Every relationship MUST keep its current meaning and enforcement — including invoice ↔
  lines, rolls ↔ stock movements, party ↔ ledger/vouchers/invoices/returns, returns ↔ lines,
  orders ↔ items, sync devices ↔ outbox/inbox/claims/number blocks, and tenant ownership — with the
  same delete/restrict behavior as today (C-4).
- **FR-010**: Technical runtime state (installation, process, session state) MUST be stored separately
  from business data and MUST NOT be treated as company data (DB-3).
- **FR-011**: `ledger_entry_archive` MUST be kept for schema parity. Finding (OQ-7): it is
  supplementary and currently unused — nothing writes or reads it, and all ledger history lives in
  `ledger_entries`. Full ledger history MUST stay reachable in statements, reports and audit
  (DB-6, U-7).

#### PostgreSQL-specific behavior to reproduce

- **FR-012**: Every PostgreSQL-specific mechanism the current backend relies on MUST be inventoried
  before the design is finalized, and each MUST be reproduced with identical observable behavior
  (DB-7, C-6). The inventory MUST at least cover these behaviors already known to exist:
  - **Append-only records**: ledger entries and license audit events cannot be edited or deleted
    after creation.
  - **Automatically maintained daily cash-box balances**: daily balances per currency stay
    consistent with ledger and manual cash movements without a separate user action.
  - **Sync inbox ordering stamp**: applied sync units receive a monotonically increasing applied
    sequence used as a cursor.
  - **Tenant isolation**: a company's data is never visible to or modifiable by another tenant
    context (currently enforced by row-level security).
  - **Serialized access to contended records**: two concurrent operations cannot both consume the
    same roll stock, the same document number or the same resource claim (currently row locks).
  - **Insert-or-update and returned-values semantics**: operations that today upsert or read back
    generated values produce the same stored results.
  - **Fuzzy/partial text search**: search results for parties, fabrics and documents match today's
    results for the same query, including Arabic text.
  - **Generated identifiers and sequences**: identifiers and document numbering follow the same
    rules and never collide.
- **FR-013**: Each reproduced mechanism MUST be covered by a parity test that compares the new build's
  behavior to the PostgreSQL build; removing a mechanism's effect without an equivalent is a defect.
- **FR-014**: Monetary amounts and quantities MUST keep exact decimal semantics, including rounding,
  in both SYP and USD; exchange-rate meaning and cash-box calculation method MUST be unchanged
  (C-3).

#### Accounting and business behavior parity

- **FR-015**: For the same inputs, the new build MUST produce results identical to the PostgreSQL
  build for customers, suppliers, invoices, payments/vouchers, ledger, inventory (fabrics, colors,
  rolls, stock movements, inventory counts), cash box, multi-currency (SYP/USD), returns, orders,
  expenses, print jobs, settlements and financial years (C-1, C-2).
- **FR-016**: Party deletion, party purge cascade, dye purge cascade, party merge, financial-year
  close and reopen, and cancellation of invoices, vouchers and returns MUST keep the same logic and
  results (C-5).
- **FR-017**: Cancelled or deleted records MUST NOT appear as active in any list, search or lookup
  path (P-5). Cancelled customers and suppliers MUST be hidden from normal operational lists, including
  the default "all" view, while remaining stored and reachable for audit and history, and by id on the
  historical documents that reference them (D-4). Today's PostgreSQL behavior, which lists them under "all", is the defect.
  It is not the parity reference.
- **FR-018**: Screens, workflows, activation and licensing MUST stay as they are; changes forced by
  the engine MUST be implementation-only and MUST NOT alter business behavior or final results
  (C-6, C-8).

#### Transactions and durability

- **FR-019**: Every business operation that affects several records (e.g. invoice + lines + ledger
  entries + cash and/or stock movement) MUST be saved atomically: fully saved or not saved at all
  (C-9, DB-4).
- **FR-020**: The app MUST report a save as successful only once it is durable; every confirmed save
  MUST survive power loss, Windows crash and backend crash (C-10, DB-5).
- **FR-021**: Durability MUST NOT be traded for speed; the chosen durability configuration MUST be
  proven by crash, force-kill and power-loss tests (Principle IV).

#### History and completeness

- **FR-022**: No limit, cap or silent truncation may prevent a user from reaching their data; there
  is no product-level maximum data volume (C-11, DA-1).
- **FR-023**: All historical invoices, vouchers, payments, stock movements, cash box, returns,
  accounts, ledger and statements MUST remain searchable, printable and auditable from the same
  system after 4, 10 or more years (DA-2).
- **FR-024**: A customer statement MUST show complete detailed history with correct opening balances
  and subsequent movements (DA-3); year close MUST NOT hide prior-year detail or replace it with an
  opening balance (DA-4); any internal archiving MUST be transparent and use the same calculation
  logic (DA-5).
- **FR-025**: Data completeness MUST first be baselined on the PostgreSQL build and then required of
  the new build (§5.3, AC-9). The pagination/limit fixes themselves are delivered on a separate track
  that MUST land before SQLite acceptance testing begins and MUST cover every capped "load all"
  path, including the 1000-page statement cap and the 200-page party-list limit (OQ-11).

#### Installation and data identity

- **FR-026**: The database MUST live in a fixed location in the application's per-user AppData,
  independent of the EXE install location and not on removable or external drives; each Windows user
  account's data MUST be isolated (ID-1, ID-2).
- **FR-027**: The app MUST decide between "update of the same installation" and "new installation"
  using installation identity and data identity together, never from the presence of a port or a
  single file (ID-3). Finding (OQ-10): today's identity combines a per-user/PC device binding, a data
  stamp and a data-directory marker, plus a separate machine-wide backend installation ID; the
  SQLite-era definition, and whether a same-user reinstall triggers the ID-5 choice, are decided in
  planning.
- **FR-028**: When the same installation is proven, which means a normal restart or an application update of that
  installation, the app MUST reuse the same database automatically (ID-4, D-1).
- **FR-029**: When a new installation (including a reinstall after uninstall) finds prior data, the app
  MUST NOT delete, replace or open it silently. It MUST tell the user a saved project exists and require an
  explicit choice: open the existing data, restore a backup, or start a new project. Starting a new
  project MUST keep the prior data aside, undeleted (ID-5, D-1).
- **FR-030**: At startup the app MUST distinguish and clearly present: existing database, mismatched
  database, corrupt database, previous data present; where important data may exist it MUST offer
  explicit restore/open or start-new options and MUST NEVER delete automatically (ID-6, C-13).
- **FR-031**: The app MUST be able to show which database, data root and tenant it is connected to
  (ID-7).
- **FR-032**: A clean first install MUST contain no prior data, settings or database (ID-8).
- **FR-033**: When the database file is locked at startup, nothing MUST be deleted or replaced; a
  leftover process of the same installation MUST be awaited or terminated safely; an unknown lock
  holder MUST halt safe startup with a clear state, without declaring corruption or creating a new
  database (RT-6).
- **FR-034**: The app MUST never connect to a wrong database and never create a substitute database
  without an explicit user decision (AC-10).

#### Lifecycle

- **FR-035**: Open, close and Windows restart MUST behave like a normal Windows application and show
  the same data after reopening (LC-1, LC-2, LC-3).
- **FR-036**: An update while the app is running MUST follow: save state → safely close the app and
  internal services → apply the update → relaunch on the same data; an update MUST never replace or
  create a database, and a failed shutdown MUST never be interpreted as corruption (LC-4).
- **FR-037**: An update after a long gap (one to four or more years) MUST continue on the same
  database and history via schema versioning and forward migration (LC-5, DB-9).
- **FR-038**: Uninstall MUST preserve the database and backups; permanent deletion requires a clear,
  deliberate user action (LC-6, C-12).
- **FR-039**: Reinstall MUST follow FR-027 to FR-030 (LC-7).
- **FR-040**: The new build MUST start from a clean local database and MUST NOT contain any migration
  path for existing PostgreSQL data in this phase (DB-8).

#### Backup

- **FR-041**: A backup MUST be a complete company backup sufficient to rebuild the company in the same
  state: all accounting and business data (customers, suppliers, invoices, payments, ledger,
  inventory, cash box, returns, orders, financial years, opening balances), attachments, company
  settings, and everything needed to open the company in the same state (BK-1).
- **FR-042**: A backup MUST include the license information tied to the company that identifies the
  copy (the company's licence record, without its device-binding and device-issued offline-token fields),
  and MUST exclude device secrets and device-bound state: activations, device registrations,
  installation records, secrets, revoked tokens, idempotency keys, invitation codes, and the
  device-activation audit log (`license_audit_events`). A restore MUST keep the restoring device's own
  device-bound state, and a restore onto a new device MUST require licence verification there (BK-2).
- **FR-043**: Users MUST be able to take a manual backup (BK-3).
- **FR-044**: The app MUST take an automatic backup before update, restore, year close and reopen,
  purge, merge, and any operation that can affect large amounts of data (BK-4).
- **FR-045**: The app MUST take periodic automatic background backups without disturbing the user:
  daily (at startup when the newest automatic backup is older than 24 h, and every 24 h while the app
  is open), keeping the 7 newest, stored in `%LOCALAPPDATA%\motard-erp\backups` with a mirror copy
  under the user's Documents folder (OQ-5) (BK-5, BK-9).
- **FR-046**: Every backup MUST be validated immediately on creation — archive intact, all required
  files present, database opens, integrity check passes, metadata matches — and MUST be marked
  VERIFIED only after validation passes; producing a file is not success (BK-6, BK-7).
- **FR-047**: Backups MUST be stored where they survive uninstall (BK-9, C-12).
- **FR-048**: Actual restore tests MUST run: weekly, the app silently restores its newest automatic
  backup into a temporary location and runs the RS-5 comparison; and every release gets a manual
  restore on a clean VM (OQ-6) (BK-8).

#### Restore

- **FR-049**: Restore MUST work on the same device and on a new device (RS-1).
- **FR-050**: Every backup produced by any SQLite-era app version MUST be restorable on any newer
  version; PostgreSQL-era backups MUST be rejected with a clear message (OQ-3, DB-8) (RS-2).
- **FR-051**: Restore MUST follow: automatic backup of the current state → copy the backup → migrate
  the copy → verify → open; the original backup MUST never be modified (RS-3, RS-6).
- **FR-052**: Incompatible or incomplete backups MUST be rejected clearly; a partial database MUST
  never be opened (RS-4).
- **FR-053**: After restore, the app MUST compare against the source: record counts, customers and
  suppliers, invoices, balances, ledger, inventory, cash box and account statements (RS-5).

#### Sync compatibility

- **FR-054**: The existing sync mechanism MUST move to the new engine unchanged in principle and data
  meaning: outbox/inbox, tombstones, per-device document-number blocks, resource claims, optimistic
  concurrency, and the keep-server / rebase / withdraw conflict decisions (SY-1).
- **FR-055**: Every device MUST work fully offline with no artificial offline time limit (SY-2). The
  engine change MUST NOT introduce any offline limit in sync or licensing. Any existing licensing
  offline rule (for example the licence `grace_days` field and offline-token expiry) MUST be identified, and
  its offline effect on the SQLite build MUST equal the PostgreSQL reference (C-8).
- **FR-056**: Data exchanged with the central PostgreSQL sync server MUST be compatible with what the
  current build exchanges, so the unchanged server accepts and produces the same records with the
  same meaning (amounts, dates/times, identifiers, flags and structured data) (Principle VIII).
- **FR-057**: After sync and conflict resolution, all participating devices and the server MUST reach
  the same business state: invoices, document numbers, customers and suppliers, balances, ledger,
  inventory, cash box and business data; device-local technical state is excluded (SY-3).
- **FR-058**: Conflicts MUST be resolved through the existing conflict policy with no silent overwrite
  and no lost operation, and the result MUST propagate identically to every device (SY-4).
- **FR-059**: Sync scope MUST stay as it is today — invoices, vouchers, returns, orders, expenses,
  customers, suppliers, fabrics, colors, rolls, ledger, settlements, cash box, and settings, company
  and users per current scope — with current exclusions kept (SY-5).
- **FR-060**: Restore on a synced device MUST: recognize the database is an older snapshot, pause
  sync, tell the user newer data exists on the server, compare backup state with server state and
  identify post-backup operations, and reconcile safely before sync resumes: newer server operations
  re-download automatically, and review mode opens only when local changes made after the restore
  conflict with them (OQ-12) (SY-6).
- **FR-061**: Restore MUST never automatically delete or overwrite newer operations, erase server
  history, republish old operations as new, or let the server blindly add whatever is missing (SY-7).

#### Packaged-EXE acceptance and release blocking

- **FR-062**: Every acceptance gate AC-1 to AC-12 MUST be executed against the final packaged
  Windows EXE, and the EXE that passed MUST be the exact EXE that ships (AC-12, P-7).
- **FR-063**: The §10.1 lifecycle protocol MUST be run in order on a real or clean virtual Windows
  environment with no prior data, on every supported Windows version — 64-bit Windows 10 22H2 and
  Windows 11 (OQ-1): clean install → first run → create realistic data →
  close and reopen → crash and force-kill → Windows restart → update to a new version → uninstall →
  reinstall → backup → restore, verifying the same data after each stage.
- **FR-064**: Volume and performance testing MUST use large volumes measured on real screens,
  statements and reports; test volumes are not product limits (§10.2). Gate (OQ-4): at 100,000
  invoices, 200,000 ledger rows and 10,000 parties, list screens and a statement's first page appear
  in under 2 s and a complete single-party statement in under 10 s; an informational soak run at
  1,000,000 invoices is also performed and reported, but is not a gate.
- **FR-065**: Code reading, unit tests or build-tool test runs alone MUST NOT satisfy any gate; each
  gate requires an executed test with a PASS report (§10).
- **FR-066**: A single FAIL in any gate MUST block delivery. In particular, any of the following
  blocks release: data loss or corruption; an accounting or financial mismatch against the
  PostgreSQL reference; wrong-company or wrong-database opening, or a silent substitute database; an
  unverified backup or a failed/incomplete restore; sync divergence or a lost operation; any
  PostgreSQL binary, process or local database TCP port in the packaged build.
- **FR-067**: If U-1 (customer found but list empty) or U-2 (invalid backup root cause) is unresolved
  at release, the release report MUST state so explicitly; neither may be assumed fixed by the
  engine change (§9). Finding (OQ-8): the code-level mechanisms for both are established (see
  Clarifications), but the cause of each original incident is not; each mechanism MUST be closed
  and covered by an acceptance test.
- **FR-068**: When a list or its backing cache fails to load, the app MUST show a clear error with a
  **Retry** action and MUST NOT show an empty list or a "no records" state (D-3). This is an approved
  pre-reference defect fix (FR-070).
- **FR-069**: On the desktop, the backend installation identity MUST be stored per Windows user and
  linked to the desktop installation identity. It MUST NOT be shared machine-wide across Windows users
  (ID-2, D-2). The cloud keeps its current behavior.
- **FR-070**: The only behavior changes permitted in shared or cloud code paths are the approved
  pre-reference defect fixes: D-4 (FR-017), D-3 (FR-068) and the pagination/history-completeness fixes
  (FR-025). Each MUST be applied to and verified on the PostgreSQL build before the parity reference is
  frozen. Every other shared-code change MUST leave cloud behavior unchanged (FR-006).

### Key Entities *(include if feature involves data)*

All 54 entities in `ERP_GENOME.md` are in scope and preserved; the groups below are those this
feature touches most directly.

- **Company (tenant)**: The owning business; almost every record belongs to exactly one tenant.
  Its identity is part of "data identity" and must be displayable (ID-7).
- **Parties (customers/suppliers)** and **yearly party summaries**: Counterparties with balances
  derived from ledger history; summaries may assist display but never replace detail. (The former
  `party_balances` cache was dropped by migration `0038` and is not part of the live schema.)
- **Invoices and invoice lines**, **returns and return lines**, **orders and order items**,
  **vouchers**, **expenses**, **print jobs**, **settlements / financial operations**: Business
  documents whose amounts, statuses (including `cancelled`) and relationships must be preserved.
- **Ledger entries** and **ledger entry archive**: The append-only accounting record per party; the
  archive's role is an open question (OQ-7).
- **Inventory: fabrics → colors → rolls**, **stock movements**, **inventory counts**: Stock structure
  and movements; contended rolls must never be double-consumed.
- **Cash box: sessions, manual movements, daily balances, day closes**: Cash per currency (SYP/USD)
  with automatically consistent daily balances.
- **Financial years**: Year close/reopen state; never hides prior detail.
- **Document sequences and document-number blocks**: Per-device numbering that must never collide
  across synced devices.
- **Sync: devices, authorized users, outbox, inbox, tombstones, resource claims, conflicts, state**:
  The offline-first replication record exchanged with the central server.
- **Licensing and installation: licenses, activations, device registrations, license audit events,
  server installations, secrets, setup wizard state, revoked tokens**: Identity and entitlement
  records; device secrets and binding are excluded from backups.
- **Settings, company profiles, users, attachments, audit logs, notifications, idempotency keys,
  schema migrations**: Configuration, people and supporting records included in a complete backup
  as applicable.
- **Backup**: A complete company snapshot with a VERIFIED/failed status, source app/schema version
  and metadata used for compatibility and post-restore comparison.
- **Installation identity / data identity**: The pair used to decide reuse vs new install vs
  mismatch; stored separately from business data (OQ-10).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the AC-3 parity scenarios (customers, suppliers, invoices, vouchers, ledger,
  inventory, cash box, SYP/USD, returns, settlements, cancellations, purge cascades, merge, year
  close and reopen) produce zero differences in calculations, balances, account statements and
  relationships between the current build and the new build.
- **SC-002**: The packaged build contains zero database-server binaries and zero port files, and a
  running instance has zero listening local database ports and zero visible database services.
- **SC-003**: All 11 stages of the §10.1 lifecycle protocol pass on both Windows 10 22H2 and
  Windows 11 (64-bit), with record counts and balances unchanged after every stage.
- **SC-004**: Across forced crash, force-kill and power-loss tests during multi-record saves, 0
  operations are found partially saved and 0 user-confirmed saves are missing afterwards.
- **SC-005**: In every reinstall, mismatch and "prior data found" scenario tested, the app opens the
  wrong company or a substitute database 0 times and deletes data without explicit user action 0
  times.
- **SC-006**: 100% of backups reported as successful are VERIFIED, and 100% of verified backups
  restored on the same device and on a new device pass the post-restore comparison with zero
  differences.
- **SC-007**: In the A/B offline scenario (20 + 30 invoices, including same-record and same-roll
  conflicts), both devices and the server end with exactly 50 invoices and identical document
  numbers, parties, balances, ledger, inventory and cash box; 0 operations lost.
- **SC-008**: At 100,000 invoices, 200,000 ledger rows and 10,000 parties, 100% of historical
  records and statement lines reachable on the PostgreSQL baseline are reachable on the new build,
  with zero truncated results; list screens and a statement's first page appear in under 2 seconds
  and a complete single-party statement in under 10 seconds.
- **SC-011**: The backend restarts silently at most 3 times within any 5-minute window, and a
  stopped-service message appears on the next failure in that window.
- **SC-012**: Over any 7-day period with the app in normal use, at least 7 VERIFIED automatic
  backups exist (in both the primary and mirror locations), and at least one weekly automatic restore
  test has passed the RS-5 comparison.
- **SC-009**: A support person can identify the connected database location, data root and company
  from within the app in a single visit to the relevant screen, without external tools.
- **SC-010**: Every release candidate ships only after all 12 gates show an executed PASS report on
  the exact EXE being shipped.

## Assumptions

- There is no real end-customer data today; all existing data is test data, so no legacy-data
  migration is needed in this phase (§5.2, DB-8).
- The current PostgreSQL desktop build is available and runnable as the parity reference for AC-3
  and the AC-9 completeness baseline (§11 step 1).
- SYP/USD dual-currency behavior is part of "multi-currency" and "cash box and currencies" in the
  PRD and is preserved without change.
- The existing Named Pipe frontend ↔ backend channel is kept; only the database access path changes.
- The central sync server's protocol and behavior stay as they are; compatibility is achieved on the
  desktop side.
- The PostgreSQL-specific mechanisms listed in FR-012 are known from current repository evidence;
  the full inventory required by DB-7 may find more, and each found is in scope.
- Screens and workflows are unchanged except where the PRD itself requires new states (ID-5/ID-6
  prior-data and mismatch choices, ID-7 connection display, RT-4 service-stopped message, BK-7
  VERIFIED status, SY-6 restore-on-synced-device notice, D-3 list-load error with Retry).
- The pagination/limit fixes are a separate track (§5.3); this feature consumes its results for AC-9.

## Dependencies

- Open questions OQ-1 to OQ-12 and decisions D-1 to D-4 are resolved (see Clarifications and the table
  below).
- The separate pagination/limits track (§5.3), which must land before SQLite acceptance testing.
- A clean real or virtual Windows environment for each supported Windows version for the §10.1
  protocol.
- The central PostgreSQL sync server, unchanged, for SY and AC-8 testing.

## Open Questions (from PRD §12)

All twelve are resolved as of 2026-10-03: owner decisions for OQ-1–6, 11 and 12, and repository
findings for OQ-7–10 (details in Clarifications).

| ID | Question | Resolution | Affects |
|---|---|---|---|
| OQ-1 | Supported Windows versions | Windows 10 22H2 + Windows 11, 64-bit | FR-063, SC-003 |
| OQ-2 | Restart bound | 3 restarts per rolling 5 minutes | FR-004, SC-011 |
| OQ-3 | Backup compatibility window | All SQLite-era versions; PostgreSQL-era rejected | FR-050 |
| OQ-4 | Test volumes and targets | 100k gate (<2 s lists, <10 s full statement) + 1M soak | FR-064, SC-008 |
| OQ-5 | Periodic backup | Daily, keep 7, AppData + Documents mirror | FR-045, FR-047, SC-012 |
| OQ-6 | Restore-test frequency | Weekly in-app + per-release clean VM | FR-048, SC-012 |
| OQ-7 | `ledger_entry_archive` role | Supplementary, unused (finding) | FR-011 |
| OQ-8 | U-1 / U-2 causes | Mechanisms found; incident causes unproven (finding) | FR-067 |
| OQ-9 | One backend for both? | Yes, one codebase and entry point (finding) | FR-006 |
| OQ-10 | Identity definition | Documented (finding); reinstall policy decided (D-1) | FR-027–FR-029 |
| OQ-11 | Pagination track | Before acceptance; all capped paths | FR-025 |
| OQ-12 | Restore on synced device | Auto re-download; review only on conflict | FR-060 |
