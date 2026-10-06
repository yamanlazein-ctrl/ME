# PRD — Desktop Local Database Replacement (PostgreSQL → SQLite)

| Field | Value |
|---|---|
| Product | Motard — textile & fabric ERP, Windows desktop edition |
| Document type | Product Requirements Document + project-rescue plan |
| Project type | Change to an **existing** production-architecture ERP (not greenfield) |
| Scope in one line | Replace the desktop's embedded local PostgreSQL with embedded SQLite, keep everything else behaviorally identical, and close the failure classes that the current desktop runtime exposed |
| Status | Draft for review |
| Sources of truth | (1) Project discovery interview with the owner; (2) `ERP_GENOME.md` system map (54 tables, 86 relationships) |

**Tag legend** (used throughout): **CURRENT** = exists today · **PROBLEM** = actual problem · **GOAL** = required outcome · **CONSTRAINT** = must not change · **PROVEN** = established by test/evidence · **UNKNOWN** = not yet established · **[TBD]** = decision not yet made · **(derived)** = requirement inferred directly from a confirmed requirement, not stated verbatim.

---

## 1. Executive Summary

Motard's desktop edition currently runs a full PostgreSQL 17 server on the customer's Windows machine, managed by the desktop runtime. PostgreSQL itself is **not** the problem: it passed durability testing at 100,000 invoices and 200,000 ledger rows. The problem is that operating a database server inside a consumer Windows application introduced a large runtime surface — process lifecycle, ports, `pg_ctl`, `pgdata` reuse, metadata, installation identity — and that surface has produced real, reproduced failures: stale data resurfacing after reinstall, an invalid backup reported as created, and records the app hid or showed incorrectly.

This project replaces the **desktop-local** database engine with embedded SQLite so the product behaves like a normal Windows application. It is explicitly **not** a rebuild of the ERP: accounting meaning, business rules, relationships, sync behavior, screens, activation, and licensing stay the same. Any difference in financial results between the current PostgreSQL build and the new SQLite build is a defect.

Swapping the engine does **not** by itself fix the failures that triggered this project. Several of them (installation identity, status filtering, backup validity) are application-level defects that would carry over to SQLite unchanged. This PRD therefore treats each previously observed failure as a requirement with its own acceptance gate.

---

## 2. Why This Change, and Why Now

### 2.1 What is proven about the current system

| # | Fact | Tag |
|---|---|---|
| P-1 | PostgreSQL 17.10 durability test reached 100,000 invoices; the day-one invoice remained accessible. | PROVEN |
| P-2 | 200,000 ledger rows were walked via the statement keyset path in the backend. | PROVEN |
| P-3 | Reconnect, migration rerun, database copy, and recovery from immediate PostgreSQL shutdown succeeded. | PROVEN |
| P-4 | After a reinstall in the test environment, old `pgdata`/data was reused. **Root cause:** `installation_id`, `pgdata`, and metadata survived in AppData, so the system chose REUSE and did not correctly distinguish an upgrade of the same installation from a new installation. | PROVEN |
| P-5 | A deleted record appeared in a list. **Root cause:** PostgreSQL correctly set the status to `cancelled`, but `list()` did not enforce the status filter. Verified by direct test. | PROVEN |
| P-6 | A backup file produced by the application was invalid when opened. | PROVEN (occurrence); root cause UNKNOWN |
| P-7 | Differences were observed between some build artifacts and the shipped EXE. | PROVEN (occurrence) |
| P-8 | `useStatement.ts` (frontend) contains a silent cap of ~1000 pages on statement loading. Some `fetchAll` paths risk loading very large volumes. | PROVEN (defect exists) |

### 2.2 What is not proven

| # | Open item | Tag |
|---|---|---|
| U-1 | A customer record (e.g. "محمد") was found by the system while the customer list showed no customers. Which database, `DATA_ROOT`, and tenant the EXE was connected to at that moment is not established. | UNKNOWN |
| U-2 | Root cause of the invalid/corrupt backup ZIP. | UNKNOWN |
| U-3 | Real EXE lifecycle under crash / reboot / update / reinstall has not been tested end-to-end. | UNKNOWN |
| U-4 | Stale-process and full-update failures are risks, not confirmed incidents. | UNKNOWN |
| U-5 | Multi-device sync is not proven end-to-end across all scenarios. | UNKNOWN |
| U-6 | No documented evidence that these failures occurred at a real customer site. (There are currently no real end-customer data sets — see §5.) | UNKNOWN |
| U-7 | Role of `ledger_entry_archive` in the current PostgreSQL design: part of the source of truth, or supplementary storage? | UNKNOWN |

### 2.3 The actual problem

**PROBLEM:** The complexity of running and managing a local database server inside a Windows app, and the risk that these layers cause the app to fail, show wrong data, or lose access to customer data. In particular:

- starting/stopping PostgreSQL with the app; managing `postgres.exe`, `pg_ctl`, the port, metadata, and runtime state on the customer machine;
- dynamic local TCP port management; possible stale processes;
- startup / shutdown / recovery complexity;
- updating after long periods; reinstalling and reusing `pgdata`;
- telling old-installation data apart from new-installation data;
- backup and restore;
- data that exists in the database but is not shown correctly.

Cases that looked like data loss were, on investigation, data that **existed** but was hidden by a status/filter defect, read from a different `DATA_ROOT`, or stale data being reused. These are the failure classes this project must close.

---

## 3. Current State (CURRENT)

```
Tauri (desktop shell)
  └─ React SPA in WebView2
       └─ Named Pipe (not HTTP localhost)
            └─ Node.js / Express local backend
                 (business logic, use cases, repositories)
                 └─ PostgreSQL 17 — launched by the desktop runtime
                      data in DATA_ROOT\pgdata
                      reached via a dynamic local TCP port
```

Supporting runtime: a Supervisor, a Windows Job Object, and startup / shutdown / recovery logic managing Node and PostgreSQL; plus update, restart, and AppData management logic.

Domain covered by the backend (unchanged by this project): invoices, customers, suppliers, payments/vouchers, ledger, inventory (fabrics, colors, rolls, stock movements), cash box, returns, orders, expenses, print jobs, settlements, financial years, multi-currency, licensing, and multi-device sync.

Off-device (unchanged): cloud backend, admin dashboard, and central sync server, all on PostgreSQL.

---

## 4. Target State (GOAL)

```
Tauri (desktop shell)
  └─ React SPA in WebView2
       └─ Named Pipe / IPC only
            └─ Node.js / Express local backend — internal, invisible to the user
                 └─ SQLite — embedded, single database in a fixed AppData location
```

- No local PostgreSQL. No `postgres.exe`, `pg_ctl`, database port, or `db-port.txt`.
- No local database TCP port of any kind. All local communication stays inside the application via IPC / Named Pipe.
- Node remains an internal process managed by Tauri. It must not be visible to, or felt by, the user as an app or server.
- The customer experiences a normal Windows application: it opens and works; it closes and is done; after a Windows restart it opens with the same data; after an update one or four years later it continues on the same database and the same historical data.

---

## 5. Scope

### 5.1 In scope

1. Replace the desktop-local database engine with SQLite, covering **every** table, relationship, and function the current system depends on.
2. Remove PostgreSQL lifecycle management from the desktop runtime and simplify the Supervisor/Job Object to backend-lifecycle duties only.
3. Review and rework, for SQLite: **first run, reinstall, update, backup, restore.** (These are the flows where the old failures occurred.)
4. Installation identity and data identity, so that reuse, new-install, and mismatch situations are detected explicitly.
5. Backup and restore that are verified, not just created.
6. Re-testing of the existing sync mechanism end-to-end on SQLite.
7. Proving behavioral and financial parity between the PostgreSQL build and the SQLite build.
8. Full-lifecycle acceptance testing of the packaged EXE on clean Windows.

### 5.2 Out of scope

| Item | Why |
|---|---|
| Re-designing business logic, accounting, screens, or workflows | The goal is an engine replacement, not a product redesign. |
| Changing the cloud backend, admin dashboard, or central sync server | They stay on PostgreSQL. |
| Migrating existing PostgreSQL data | There is no real end-customer data today. All existing data is test data. The new build starts from a clean SQLite database. **No legacy-data migration code may be introduced in this phase.** |
| Expanding or reducing sync scope | Scope stays as it is today. Exclusions stay excluded unless changed by a separate decision. |
| User-chosen database location (other drives, USB) | Moving data elsewhere is done only through official backup/restore. |

### 5.3 Separate track (not merged into this project's implementation)

**Pagination and silent limits (P-8).** The owner's decision is that the pagination/limit fixes are an **independent workstream**, kept separate so SQLite's real effect can be measured without confounding issues. However:

- data completeness is first **established on PostgreSQL** as the baseline, and
- the same completeness is an **acceptance requirement** for the SQLite build (see AC-9).

---

## 6. Non-Negotiable Constraints

| ID | Constraint |
|---|---|
| C-1 | **Behavioral parity 1:1.** The current PostgreSQL build is the reference. Every value, movement, and result must equal what PostgreSQL produces. Any difference in accounting meaning or financial result is unacceptable. |
| C-2 | **Accounting rules unchanged in meaning.** Same invoices, customers, suppliers, payments, vouchers, ledger, inventory, cash box, currencies, returns, settlements, financial years, and sync. |
| C-3 | **Cash box and currencies unchanged.** Same calculation method, same meaning of exchange rate, same financial movements. |
| C-4 | **All relationships stay 100% correct with the same meaning.** These include invoice ↔ lines, inventory ↔ movements, customer ↔ account, vouchers ↔ ledger, cash box, returns, suppliers, settlements, sync, and financial years. |
| C-5 | **Existing behaviors keep the same logic and results.** These include party deletion, purge cascades, party merge, year close and reopen, cancellation of invoices / vouchers / returns, and balance computation. |
| C-6 | **SQLite-driven changes are implementation-only.** Where SQLite technically forces a change, only the implementation changes. Business behavior and final results stay the same. |
| C-7 | **No schema reduction.** No table or relationship is dropped because current data is test data. |
| C-8 | **Screens, flows, activation, and licensing stay as they are** as far as possible. |
| C-9 | **Atomicity.** A financial operation that affects several records (e.g. invoice + ledger entries + cash and/or stock movement) is one atomic transaction. It is fully saved or not saved at all. |
| C-10 | **Durability of confirmed writes.** Anything the system shows the user as successfully saved must still exist after power loss, Windows crash, or backend crash. |
| C-11 | **No artificial caps.** No LIMIT, cap, or silent truncation may prevent a user from reaching their historical data. Performance is solved by design, indexes, keyset pagination, and correct internal archiving, never by hiding data. |
| C-12 | **Uninstall never deletes company data.** The database and backups survive uninstall. Permanent deletion requires a clear, deliberate user action. |
| C-13 | **No blind decisions on existing data.** The system must never automatically delete, replace, or silently open pre-existing data, and must never silently create a substitute database. |

---

## 7. Functional Requirements

### 7.1 Database engine and data model (DB)

| ID | Requirement |
|---|---|
| DB-1 | SQLite is the **only** desktop database. No PostgreSQL binaries, process, or port exist in the desktop build. |
| DB-2 | The SQLite schema supports every table, relationship, and function the current system relies on (54 tables / 86 relationships per the system map). |
| DB-3 | Technical runtime state is stored separately from business data and is not treated as company data. |
| DB-4 | Every multi-record business operation runs in a single atomic transaction (C-9). |
| DB-5 | A write is reported as successful to the user only once it is durable (C-10). (derived) |
| DB-6 | Before the SQLite design is finalized, the current role of `ledger_entry_archive` is determined (U-7). Whatever the final storage design, the full ledger history stays reachable in statements, reports, and audit. |
| DB-7 | PostgreSQL-specific mechanisms the current backend relies on are inventoried, and each is reproduced at implementation level with identical behavior (C-6). (derived) |
| DB-8 | The new build starts from a clean SQLite database. It contains no migration path for legacy PostgreSQL data in this phase. |
| DB-9 | Schema versioning and forward migration exist so that an update — including one after years — continues on the same database. Restore of an older backup also relies on this (RS-3). (derived) |

### 7.2 Runtime and process model (RT)

| ID | Requirement |
|---|---|
| RT-1 | No local database TCP port. All local communication is IPC / Named Pipe inside the application. |
| RT-2 | Node/Express is an internal process managed by Tauri. It is invisible to the user. |
| RT-3 | The Supervisor and Job Object remain, scoped to backend lifecycle only. Their purpose is to prevent orphaned or hung processes after a crash or force-kill. Database-server lifecycle management (start, stop, `pg_ctl`, port, DB startup/shutdown) is removed. |
| RT-4 | **Backend crash while the app is open:** Tauri restarts the backend automatically and silently for transient failures. The number of attempts is bounded [TBD: count / window]. When the bound is reached, retries stop and the user sees a clear message that the internal service stopped. The message must **not** claim the database is corrupt. |
| RT-5 | **Single instance.** Two normal instances of the same installation must not run. One instance owns the session. |
| RT-6 | **Stale process / locked database file at startup:** <ul><li>Nothing is deleted or replaced automatically.</li><li>The system determines whether the process belongs to the same Motard installation, and whether it is the current session or a leftover from a crash.</li><li>If it belongs to the same app: the system waits for it to close or terminates it safely.</li><li>If the lock holder is unknown: the database is **not** treated as corrupt and no new database is created. A clear state is shown and safe startup halts until the cause is identified.</li></ul> |

### 7.3 Installation identity and data identity (ID)

These requirements exist because of P-4 and U-1.

| ID | Requirement |
|---|---|
| ID-1 | The database lives by default in a fixed, safe location in the application's AppData. It is independent of the EXE install location and does not depend on removable or external drives. |
| ID-2 | Each Windows user account's data is isolated. One user must not unintentionally open another installation's data. |
| ID-3 | The decision between "update of the same installation" and "new installation" uses **installation identity and data identity together**. It never relies on the presence of a port or of a single file. |
| ID-4 | **Same installation proven:** reuse the same database. |
| ID-5 | **New installation that finds prior data:** do not delete, replace, or enter it silently. Tell the user a saved project exists and require an explicit choice: open existing data, or start a new project. |
| ID-6 | At startup, distinguish and clearly present each condition: <ul><li>existing database</li><li>mismatched database</li><li>corrupt database</li><li>previous data present</li></ul> Where important data may exist, offer explicit restore/open or start-new options. There is never automatic deletion (C-13). |
| ID-7 | The app must be able to show which database, data root, and tenant it is connected to, so a U-1-type situation can be diagnosed. (derived from the need to resolve U-1) |
| ID-8 | A clean first install contains no prior data, settings, or database. |

### 7.4 Application lifecycle (LC)

| ID | Requirement |
|---|---|
| LC-1 | **Open:** the app opens and works directly. No database service is visible. |
| LC-2 | **Close:** the app closes completely. The user manages no database service. |
| LC-3 | **Windows restart:** reopening shows the same data. |
| LC-4 | **Update while the app is running** follows this order: <ol><li>save state</li><li>safely close the app and internal services</li><li>apply the update</li><li>relaunch on the same data</li></ol> An update must never replace the database or create a new one. A failed shutdown must never be interpreted as data corruption. |
| LC-5 | **Update after a long gap** (one to four or more years) continues on the same database and the same history. |
| LC-6 | **Uninstall** preserves the database and backups (C-12). |
| LC-7 | **Reinstall** follows ID-3 to ID-6. |
| LC-8 | The user never needs to know about, or operate, PostgreSQL, `postgres.exe`, `pg_ctl`, database ports, or `db-port.txt`. |

### 7.5 Backup (BK)

These requirements exist because of P-6.

| ID | Requirement |
|---|---|
| BK-1 | **A backup is a complete company backup**, sufficient to rebuild the company in the same state. It includes: <ul><li>all accounting and business data: customers, suppliers, invoices, payments, ledger, inventory, cash box, returns, orders, financial years, opening balances</li><li>attachments</li><li>company settings</li><li>everything needed to open the company in the same state</li></ul> |
| BK-2 | **License data:** include the license information tied to the company that is needed to identify the copy. **Exclude** device secrets and device binding, so a backup cannot be used on any device without verification. |
| BK-3 | **Manual backup:** available to the user. |
| BK-4 | **Automatic backup before sensitive operations:** update, restore, year close and reopen, purge, merge, and any operation that can affect large amounts of data. |
| BK-5 | **Periodic automatic background backup**, without disturbing the user. Schedule and retention are [TBD]. |
| BK-6 | **Immediate validation on creation:** <ul><li>the archive is intact</li><li>all required files are present</li><li>the SQLite database opens</li><li>`integrity_check` passes</li><li>metadata matches</li></ul> |
| BK-7 | **A backup is marked VERIFIED only after validation passes.** Producing a ZIP or DB file is not success. |
| BK-8 | **Actual restore tests on a clean environment**, run periodically or automatically. Frequency and level are [TBD]. |
| BK-9 | Backups are stored in a location that survives uninstall (C-12). The exact location is [TBD]. |

### 7.6 Restore (RS)

| ID | Requirement |
|---|---|
| RS-1 | Restore works on the same device and on a new device. |
| RS-2 | A backup from an older app version can be restored on a newer version, within defined compatibility limits [TBD]. |
| RS-3 | **Restore path:** backup (old version) → restore onto the new version → migration → verify → open with the same data. Migration runs on the restored copy. **The original backup is never modified.** |
| RS-4 | Incompatible or incomplete backups are **rejected clearly**. The system never opens a partial database or corrupts data. |
| RS-5 | **After restore, compare against the source:** <ul><li>record counts</li><li>customers and suppliers</li><li>invoices</li><li>balances</li><li>ledger</li><li>inventory</li><li>cash box</li><li>account statements</li></ul> |
| RS-6 | A restore is preceded by an automatic backup of the current state (BK-4). |

### 7.7 Sync (SY)

| ID | Requirement |
|---|---|
| SY-1 | **The existing sync mechanism moves to SQLite unchanged in principle and data meaning:** <ul><li>`sync_outbox` / `sync_inbox`</li><li>tombstones</li><li>per-device document-number blocks</li><li>resource claims</li><li>OCC</li><li>the keep-server / rebase / withdraw conflict decisions</li></ul> |
| SY-2 | **Offline-first.** Every device works fully locally without internet. There is no artificial offline time limit. |
| SY-3 | **Convergence.** After sync and conflict resolution complete, all participating devices and the server reach the **same final business state**: <ul><li>same invoices</li><li>same document numbers</li><li>same customers and suppliers</li><li>same balances</li><li>same ledger</li><li>same inventory</li><li>same cash box</li><li>same business data</li></ul> Device-local technical/runtime state is excluded. |
| SY-4 | **No silent overwrite and no lost operation.** Conflicts are resolved through the existing conflict policy, and the result propagates identically to every device. |
| SY-5 | **Sync scope stays as it is today.** It is not reduced by the engine change. It covers: <ul><li>invoices, vouchers, returns, orders, expenses</li><li>customers, suppliers</li><li>fabrics, colors, rolls</li><li>ledger, settlements, cash box</li><li>settings, company, and users, per the current scope</li></ul> Current exclusions stay excluded. |
| SY-6 | **Restore on a synced device:** <ol><li>The device recognizes that its database is now an older snapshot.</li><li>Sync is paused.</li><li>The user is told newer data exists on the server.</li><li>Backup state is compared with server state, and post-backup operations are identified.</li><li>Safe reconciliation: re-download newer operations from the server, or enter a review mode when conflicts exist, before sync resumes.</li></ol> |
| SY-7 | **Restore must never:** <ul><li>automatically delete or overwrite newer operations</li><li>erase server history</li><li>republish old operations as new</li><li>let the server blindly "add whatever is missing"</li></ul> |

### 7.8 Long-term data access (DA)

| ID | Requirement |
|---|---|
| DA-1 | No product-level maximum data volume. A customer may reach millions or tens of millions of invoices over the years. |
| DA-2 | All historical data stays searchable, printable, and auditable from the same system, after 4, 10, or more years. This includes invoices, vouchers, payments, stock movements, cash box, returns, accounts, ledger, and statements. |
| DA-3 | A customer statement shows the **complete detailed history**, however old. Opening balances and subsequent movements stay correct. |
| DA-4 | Year close does **not** hide prior-year detail or replace it with an opening balance. Yearly summaries may exist for performance or display, but never replace the original detail. |
| DA-5 | Any internal archiving is transparent to the user, tied to the same calculation logic, and never loses or hides a historical movement. |
| DA-6 | Performance at scale is achieved through database design, indexes, keyset pagination, and appropriate queries, and is measured on real screens, statements, and reports. |

---

## 8. Failure-Handling Matrix

| Scenario | Required behavior | Forbidden behavior |
|---|---|---|
| Power loss / Windows crash during a multi-record save | Operation is fully present or fully absent; confirmed saves survive | Partial operation (e.g. invoice without its ledger or cash movement) |
| Backend crash, app open | Bounded silent restart, then a clear "internal service stopped" message | Infinite restart loop; claiming the database is corrupt |
| App launched twice | One instance owns the session | Two normal instances on the same installation |
| Stale process of the same installation holds the DB | Wait for it, or terminate it safely | Deleting or replacing the DB |
| Unknown process holds the DB | Clear state; halt safe startup | Declaring corruption; creating a new DB |
| Update while running | Save → safe close → update → relaunch on the same data | Replacing the DB; creating a new DB; treating a failed shutdown as corruption |
| Reinstall, same installation | Reuse the same DB | Creating a new DB |
| New install, prior data found | Explicit choice: open existing or start new | Silent open, delete, or replace |
| Mismatched or corrupt DB | Clear distinct state, with restore/open/new options | Automatic deletion or substitution |
| Uninstall | Data and backups retained | Deleting company data |
| Backup created | Validated; VERIFIED only on pass | Reporting success on file creation alone |
| Restore of an older backup | Migrate a copy, verify, open; reject if incompatible | Modifying the original backup; opening a partial DB |
| Restore on a synced device | Pause sync, inform the user, reconcile safely | Overwriting newer server data; republishing old operations |
| Offline devices editing the same record or roll | Existing conflict policy; identical final result everywhere | Silent overwrite; lost operation |
| Very old statement requested | Full detailed history | Truncation, caps, summary-only |

---

## 9. Project-Rescue Traceability: Past Failures → Preventive Requirements

| Observed failure / risk | Status | Preventing requirements | Acceptance gate |
|---|---|---|---|
| Old `pgdata`/data reused after reinstall (P-4) | PROVEN | ID-3, ID-4, ID-5, ID-8, LC-7 | AC-5, AC-6, AC-10 |
| Deleted record shown in a list due to a missing status filter (P-5) | PROVEN | C-1, C-5 (cancelled-status semantics must hold in every list path) (derived) | AC-3 |
| Invalid backup reported as created (P-6) | PROVEN; root cause UNKNOWN | BK-6, BK-7, BK-8 | AC-7 |
| Build artifacts differ from the shipped EXE (P-7) | PROVEN | Acceptance runs on the final packaged EXE only | AC-12 |
| Silent ~1000-page cap in statements; `fetchAll` volume risk (P-8) | PROVEN | C-11, DA-2, DA-3 (fix is a separate track, §5.3) | AC-9 |
| Customer found but the list was empty (U-1) | UNKNOWN | ID-7; root-cause investigation required | AC-10 |
| PostgreSQL process / port / `pg_ctl` complexity | PROBLEM | DB-1, RT-1, RT-3, LC-8 | AC-1, AC-2 |
| Stale process (U-4) | Risk | RT-5, RT-6 | AC-5 |
| Update after a long time (U-4) | Risk | LC-4, LC-5, DB-9 | AC-6 |
| Multi-device sync not proven end-to-end (U-5) | UNKNOWN | SY-1 to SY-7 | AC-8 |

**Rule:** if U-1 or U-2 is still unresolved at release time, that must be stated explicitly in the release report. It must not be assumed fixed by the engine change.

---

## 10. Acceptance Criteria (Release Gates)

**A single FAIL on any gate means the build is not ready for delivery, regardless of other results.** Each gate requires an actual test with a PASS report. Code reading, unit tests, or `cargo test` alone do not satisfy any gate.

| ID | Gate |
|---|---|
| AC-1 | SQLite is the only desktop database. No PostgreSQL and no local DB TCP port exist in the packaged build. |
| AC-2 | No database or server lifecycle is visible to the user. |
| AC-3 | **Accounting parity:** the same test scenarios, run on the current PostgreSQL build and on the SQLite build, produce identical results. Coverage includes: <ul><li>customers, suppliers</li><li>invoices, payments/vouchers</li><li>ledger, inventory, cash box</li><li>currencies, returns</li><li>settlements, cancellations</li><li>purge cascades, merge</li><li>year close and reopen</li></ul> The compared outputs are: <ul><li>calculations</li><li>balances</li><li>account statements</li><li>relationships</li></ul> |
| AC-4 | No data loss or corruption across any lifecycle stage. |
| AC-5 | Data remains complete after use, close, crash, force-kill, and Windows restart. |
| AC-6 | Update and reinstall preserve the same company data, with no wrong or substitute database. |
| AC-7 | A backup is created, validated (VERIFIED), and actually restored, on the same device and on a new device. Post-restore comparison passes. |
| AC-8 | **Sync convergence (A/B):** Device A and Device B work offline independently and create invoices and changes (e.g. A: 20 invoices, B: 30). After reconnection, sync, and conflict resolution, both devices and the server show the same 50 invoices and identical: <ul><li>document numbers</li><li>parties</li><li>balances</li><li>ledger</li><li>inventory</li><li>cash box</li></ul> Same-record and same-roll conflict cases are included. |
| AC-9 | **Full history access:** old statements and history are complete, with no cap or truncation, at large test volumes. Completeness is first baselined on PostgreSQL. |
| AC-10 | The app never connects to a wrong database and never creates a substitute database without an explicit user decision. |
| AC-11 | A clean first install contains no prior data. |
| AC-12 | **All gates are executed against the final packaged EXE.** |

### 10.1 EXE lifecycle test protocol

Run on a **real or clean VM** Windows environment that starts with no prior data, settings, or database, on each supported Windows version (see OQ-1). Run these stages in order, verifying the same data after each one:

1. Clean install
2. First run
3. Create realistic data
4. Close and reopen
5. Crash and force-kill
6. Windows restart
7. Update to a new version
8. Uninstall
9. Reinstall
10. Backup
11. Restore

### 10.2 Volume and performance testing

- Tests use large volumes to demonstrate capacity. **These volumes are test sizes, not product limits.**
- Performance is measured on real screens, statements, and reports.
- Target response times and test volumes are [TBD] (OQ-4).

### 10.3 Definition of "ready to give to the customer"

The build is ready only when it is the final packaged EXE and every gate AC-1 to AC-12 has passed end-to-end with a PASS report. "It opens" or "the code tests pass" is not readiness. The end state is the same system in accounting, data, and behavior, on a local SQLite database, with a simpler and more reliable desktop runtime.

---

## 11. Delivery Sequencing (prerequisites stated in the interview)

These are ordering constraints, not a schedule.

1. **Baseline on PostgreSQL first.** Establish data completeness and the parity reference results on the current build (§5.3, AC-3, AC-9).
2. **Investigate before designing:**
   - the role of `ledger_entry_archive` (U-7 → DB-6)
   - the inventory of PostgreSQL-specific behaviors (DB-7)
3. **Build on a clean SQLite database.** No legacy migration code (DB-8).
4. **Rework the lifecycle flows:** first run, reinstall, update, backup, restore (§5.1 item 3).
5. **Run parity, sync, backup/restore, and volume testing.**
6. **Run the full EXE lifecycle protocol** on clean Windows (§10.1).
7. **Later phase, out of scope here:** use the validated SQLite build as the foundation for real customer data.

---

## 12. Open Questions

| ID | Question | Raised by |
|---|---|---|
| OQ-1 | Are both Windows 10 and Windows 11 supported? (The lifecycle protocol must cover every supported version.) | §10.1 |
| OQ-2 | Bounded restart policy: how many attempts, over what window? | RT-4 |
| OQ-3 | Backup compatibility window: which oldest app/schema versions must restore on a newer build? | RS-2 |
| OQ-4 | Volume sizes used for testing and target response times for lists, statements, and reports. | §10.2 |
| OQ-5 | Periodic backup schedule, retention policy, and storage location. | BK-5, BK-9 |
| OQ-6 | Frequency and level of automatic clean-environment restore testing. | BK-8 |
| OQ-7 | Role of `ledger_entry_archive`: source of truth or supplementary? | U-7, DB-6 |
| OQ-8 | Root cause of U-1 (customer found but list empty) and U-2 (invalid backup ZIP). | §2.2 |
| OQ-9 | Does the same backend codebase serve both the cloud (PostgreSQL) and the desktop (SQLite)? If yes, how is the two-engine split kept from changing behavior? | §3, C-1 |
| OQ-10 | How exactly are "installation identity" and "data identity" defined and stored, so they survive update but distinguish a new install? | ID-3 |
| OQ-11 | When the pagination/limits track (§5.3) lands relative to SQLite acceptance, given that AC-9 depends on it. | §5.3 |
| OQ-12 | Reconciliation UX for restore on a synced device: when does the system auto re-download, and when does it require review mode? | SY-6 |

---

## 13. Reference Note

The owner cited Al-Ameen (الأمين) accounting software's documentation as a point of comparison. It treats the database as an independently maintained component, recommends backup before maintenance, and directs users to check the SQL Server service when connectivity fails. This is a **comparison reference only**, used to illustrate the operational burden this project aims to remove. It is not a source of requirements.
