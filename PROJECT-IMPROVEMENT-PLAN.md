# MOTARD ERP — Project Improvement Plan

**Status:** Investigation and implementation blueprint only. No project source, migration, configuration, database, commit, or remote was modified for this deliverable.

**Repository inspected:** `C:\Users\Taw\Downloads\Compressed\q\ME-main`

**Reference philosophy:** `to-improve-my-project.md`, read in full. Its governing chain is:

```text
financial invariants
→ transaction atomicity
→ idempotency
→ auditability
→ reconciliation
→ recovery
→ scalability
→ measurement and monitoring
```

This plan is deliberately stricter than a bug list. It distinguishes confirmed observations from inference and from items requiring runtime proof. It preserves existing accounting meaning, per-currency behavior, stock semantics, sync semantics, tenant isolation, and append-only financial history unless a human business decision explicitly approves a change.

---

## 1. Executive Assessment

The project has a credible ERP foundation:

- PostgreSQL/Drizzle persistence with tenant columns and extensive RLS/FORCE RLS work.
- Domain/application/infrastructure separation.
- Transactional invoice, payment, stock, ledger, and outbox paths in important flows.
- Append-only ledger/cancellation patterns and stock movement history.
- Frozen FX rates and per-currency statement calculations.
- Durable sync outbox/inbox, monotonic cursors, tombstones, conflicts, device trust, and retry/dead-letter concepts.
- Broad unit, property, database, synchronization, desktop, and E2E tests.

The project is not yet proven as a ten-year financial system because the most important production guarantees are either incomplete or not measured:

1. Desktop data lifecycle can enter a clean or incomplete database without enough durable forensic evidence.
2. Restore can be destructive and must be proven safe before use.
3. Existing data-integrity work in the working tree is partial and must not be treated as complete until its startup integration and recovery semantics are verified.
4. Several frontend paths treat a paginated slice as the complete historical dataset.
5. Browser-side reports contain repeated scans, including quadratic behavior.
6. Dashboard and statement paths perform unbounded or high-fan-out historical work.
7. Sync claiming and stale-worker ownership require end-to-end race proof.
8. Financial idempotency is not universal at the API boundary.
9. Contract, schema, migration, and generated/runtime truth are not yet one authoritative system.
10. There is no real 2K/10K/50K/100K or long-sync-backlog performance evidence.

### Readiness conclusion

The project should not be described as `100/100`, guaranteed for ten years, or proven for arbitrary load. The correct target is:

```text
Pilot-ready only after Phase 0 data-safety gates pass.
Production-ready only for explicitly measured workloads whose release gates pass.
Ten-year-ready only after retention, recovery, upgrade, backup, and compaction drills converge.
```

---

## 2. Scope, Evidence Rules, and Non-Goals

### 2.0 Current-tree implementation status is not completion evidence

The repository already contains a large uncommitted working tree with several apparent repair implementations and scaffolds. Examples include new migrations, SAFE_MODE/integrity files, schema fingerprint tooling, report/search routes, sync lease fields, backup/restore changes, and performance/upgrade scripts. These must be classified separately:

| State | Meaning | Acceptable as release evidence? |
|---|---|---|
| Implemented in source | Code exists in the current working tree | No |
| Unit-tested | A focused test passes | No, not alone |
| Integration-tested | Cross-layer/database behavior passes | Not alone |
| Measured | Runtime result has dataset/environment/metrics | Required for performance claims |
| Release-gated | Required matrix, rollback, backup, security, and packaging evidence is green | Yes, for the declared scope |

Before implementation work is trusted, split the working tree into reviewable commits or equivalent review units, record the exact base SHA and dirty-tree contents, run the complete relevant test suites, and attach results with timestamp and environment. Previous reported test totals are historical claims unless freshly reproduced; they must not be repeated as current evidence without a new VERIFY-ALL run.

### 2.1 Evidence labels

Every implementation ticket and verification result must use one of:

- **OBSERVED** — directly read in current source/config/artifact.
- **REPRODUCED** — demonstrated by a controlled test.
- **MEASURED** — backed by runtime metrics with dataset/config recorded.
- **INFERRED** — logically follows from code but needs runtime proof.
- **NOT PROVEN** — evidence is insufficient.

A static complexity claim is not a timing claim. A passing unit test is not a production-scale proof. A successful HTTP backup response is not proof of a complete backup.

### 2.2 Current working tree warning

At audit time the working tree contained a large uncommitted change set, including changes in backend repositories/routes, migrations, desktop runtime, frontend reports, integrity scripts, and new repair artifacts. `REPAIR-PLAN.md` is a useful input and contains valuable findings, but it is not proof that its proposed repairs are complete. Each changed file must be re-audited and tested before being treated as a baseline.

Do not overwrite, discard, stage, commit, or push the existing work as part of this plan.

### 2.3 Non-goals

This plan does not authorize:

- deleting customer data;
- changing accounting rules merely for performance;
- changing FX, tax, discount, return, COGS, settlement, or stock meaning without explicit approval;
- silently replacing the local database;
- blindly baselining migrations;
- claiming exactly-once synchronization end-to-end;
- archiving rows before a bootstrap/reconciliation strategy exists;
- adding indexes without EXPLAIN/workload evidence;
- changing the desktop runtime to a different architecture without a migration design.

---

## 3. Philosophy Applied to the Current System

### 3.1 Double-entry truth

**Current assessment:** Strong design direction, but universal enforcement is not proven.

Observed strengths:

- Invoice creation writes invoice, lines, stock, ledger, and payment-related effects transactionally in the main repository path.
- Ledger use cases validate debit/credit balance per currency.
- Cancellation is represented through reversal/cancellation entries in important paths.
- Statements derive balances from active ledger entries.

Remaining work:

- Prove that every ledger insertion path, including manual ledger routes and sync materialization, enforces balance or rejects invalid batches.
- Add a scheduled/invocable integrity audit that finds unbalanced batches, orphan postings, invoice/ledger mismatches, duplicate financial operation IDs, stock/stock-movement divergence, and cashbox/ledger divergence.
- Ensure the audit is read-only and produces a durable report.

### 3.2 Append-only history

**Current assessment:** Ledger and stock history are designed append-only, but operational deletion paths and restore behavior require explicit proof.

Required:

- Verify all financial delete endpoints are cancellation/reversal semantics.
- Verify manual cash movement deletion policy. If deletion is allowed, document why it does not violate the organization’s audit policy; otherwise convert to reversal/void with an audit record.
- Make restore and data-repair tools preserve append-only triggers and prove trigger restoration after the operation.

### 3.3 ACID mutation boundary

**Current assessment:** Main invoice and many mutation paths use transactions; transaction coverage must be mapped endpoint by endpoint.

Required:

- Produce a mutation matrix for invoice, voucher, settlement, return, expense, cashbox, manual ledger, order, inventory, settings, and sync materialization.
- For each mutation, show the transaction owner, all repositories called, outbox enqueue boundary, locks, rollback behavior, and external calls.
- No remote HTTP, printing, filesystem export, or unbounded computation should occur while financial row locks are held unless justified and measured.

### 3.4 Derived balances and reconciliation

**Current assessment:** Statements and per-currency calculations are strong; cached/summary/archive structures are not fully operationally wired.

Required:

- Define one authoritative derived formula per balance type.
- Add reconciliation commands for ledger, invoice paid, returns, customer credit, stock, cashbox, and sync state.
- Reconciliation output must identify tenant, currency, period, entity ID, expected, actual, and source rows.
- Never auto-correct financial data silently. Repairs must be explicit, auditable, and reversible.

### 3.5 Measurement before scale

**Current assessment:** The current working tree contains a performance harness scaffold, but it prints placeholders and does not measure production workloads. This is NOT MEASURED.

Required:

- Build deterministic disposable datasets at 2K, 10K, 50K, and 100K invoices with controlled lines, ledger, stock, voucher, return, audit, and sync amplification.
- Record p50/p95/p99, query count/time, response size, CPU, RSS, pool wait, locks, WAL, table/index size, retries, and queue drain rate.
- Store raw results and exact environment metadata outside production.

### 3.6 Backup and recovery

**Current assessment:** Backup/restore code exists, but destructive restore semantics and tool availability make this a release blocker until restore drills pass.

Required:

- Full backup completeness manifest.
- No restore when warnings/errors exist.
- Automatic pre-migration/pre-reset/pre-restore snapshot.
- Restore to a disposable database first.
- Verify row counts, checksums, tenant identity, attachments/documents, sequences, sync cursors, outbox pending rows, tombstones, claims, and financial invariants.
- Define RPO/RTO and test them.

### 3.7 Field maturity

The project must replace confidence based on source comments or previous reports with repeatable release evidence: upgrade matrix, crash/recovery drills, load tests, security tests, backup restore drills, and real-device desktop validation.

---

## 4. Architecture and Truth Boundaries

### 4.1 Target dependency direction

```text
Frontend UI
  → frontend use cases/hooks
  → validated API client/contracts
  → HTTP routes + auth/RBAC/tenant middleware
  → application use cases
  → domain entities/calculations
  → repository ports
  → PostgreSQL repositories/transactions
  → PostgreSQL constraints/RLS/indexes

Desktop shell
  → process lifecycle/data safety/packaging only
  → bundled backend/static frontend/PostgreSQL

Sync
  → local transaction + outbox
  → leased push
  → hub idempotency/materialization
  → monotonic pull/cursor
  → conflict/tombstone/reconciliation
```

The desktop shell must not reimplement financial rules. The frontend must not be the authoritative calculator for historical financial reports. The hub must not be treated as a substitute for local transaction atomicity.

### 4.2 Authority map to establish

Create and maintain an authority table:

| Concept | Authoritative source | Read models/caches | Validation owner | Reconciliation |
|---|---|---|---|---|
| Invoice total | normalized shared/domain formula persisted in invoice | frontend DTO/display | shared schema + backend | invoice/line invariant |
| Ledger balance | ledger entries by currency | statement/report cache | repository/use case/DB | ledger audit |
| Customer credit | ledger/credit formula | UI display | backend transaction | credit reconciliation |
| Stock remaining | roll state plus stock movements | inventory cache | locked mutation | roll/movement audit |
| Cashbox | ledger/manual movement/session formula | dashboard/cache | cashbox transaction | cash reconciliation |
| Sync delivery | op ID + inbox/outbox state | status UI | unique constraints/lease | queue audit |
| Tenant identity | authenticated JWT/server-selected tenant | frontend context/cache | auth/RLS | tenant consistency audit |
| Schema | ordered migration journal + fingerprint | desktop template | startup verifier | schema drift report |

No new cache or summary table may be added without naming its source of truth and reconciliation mechanism.

---

## 5. Findings and Improvement Workstreams

Each workstream below is implementation-ready only when its tests and release evidence are present.

---

# PHASE 0 — Customer Data Protection and Recovery

No new desktop installer should be distributed to customers until the phase-0 gates pass.

## IMP-001 — Durable boot-decision forensic log

**Status:** CONFIRMED RISK. Desktop runtime logs important decisions to stderr while release mode may have no durable console; `server.log` is opened/truncated per boot.

**Symptom → mechanism → root cause:**

```text
Customer sees empty system
→ no durable record of reuse/fresh/reset/migration decision
→ cannot distinguish data loss, wrong path, or clean provisioning
→ recovery becomes guesswork
```

**Affected areas:**

- `desktop/src-tauri/src/runtime/mod.rs`
- `desktop/src-tauri/src/runtime/stack.rs`
- `desktop/src-tauri/src/runtime/stages.rs`
- server log initialization
- PostgreSQL log path

**Implementation:**

1. Create a boot ID at process start.
2. Write structured append-only boot events to `%LOCALAPPDATA%\motard-erp\logs\boot.log`.
3. Rotate by size and retain a bounded number of files.
4. Preserve a current `server.log` for fatal dialog tailing, but rotate old server logs before opening.
5. Record only non-secret metadata:
   - boot ID;
   - installation ID prefix, not full secret material;
   - pgdata existence;
   - db-meta presence/version;
   - cluster decision: `REUSE`, `FRESH_TEMPLATE`, `FRESH_INITDB`, `FACTORY_RESET`, `FAIL_CLOSED`;
   - schema journal expected/observed;
   - selected tenant ID;
   - migration result;
   - database row-count verification result;
   - process/port/readiness transitions.
6. Never log passwords, JWTs, refresh tokens, license secrets, DPAPI content, or full backup payloads.
7. Correlate Rust boot ID, Node `MOTARD_BOOT_ID`, PostgreSQL `application_name`, and request logs.

**Must remain unchanged:** startup ordering and data semantics.

**Tests:** Rust rotation tests; boot event sequence tests; secret-redaction tests; restart log retention tests; fatal-dialog current-log test.

**Completion proof:** a fresh boot, reuse boot, migration failure, missing pgdata, and reset boot each produce an inspectable event sequence.

---

## IMP-002 — Fail closed when prior data disappears

**Status:** CONFIRMED. `evaluate_existing_cluster` can treat missing `PG_VERSION` as fresh even when prior metadata exists.

**Implementation:**

- If `pgdata/PG_VERSION` is absent and valid prior `db-meta.json` indicates an initialized installation, stop with a clear recovery error.
- Do not copy the clean template automatically.
- Explicit factory reset must remove/mark metadata first and require deliberate user confirmation.
- Provide a support-safe “locate/restore old data” path; do not offer a casual “start empty” button without an unmistakable destructive warning.
- Preserve the failed state for investigation.

**Edge cases:** first install with no metadata remains fresh; authorized reset is distinct; partially copied pgdata is failure, not fresh.

**Tests:** all metadata/pgdata combinations; interrupted copy; permission failure; installer repair; restart after failed boot.

**Completion proof:** no existing-installation marker can transition silently to a clean tenant.

---

## IMP-003 — Persistent data-integrity manifest and safe mode

**Status:** Partially implemented in the working tree; current implementation requires re-audit before acceptance.

Relevant file observed:

- `backend/src/infrastructure/integrity/dataIntegrityManifest.ts`
- `backend/src/infrastructure/http/middleware/dataSafeMode.middleware.ts`
- integrity route/UI additions in the working tree

Current strengths:

- counts for invoices, parties, rolls, ledger, vouchers, returns, and pending outbox;
- severe-drop comparison;
- read-only safe mode for mutating HTTP methods;
- atomic manifest write.

Required hardening:

1. Validate manifest structure and installation/tenant identity before trusting it.
2. Include invoice lines, stock movements, audit count, sync inbox, tombstones, conflicts, document sequences, and a database/schema fingerprint.
3. Record count provenance, timestamp, schema index, database size, and last successful backup ID/checksum.
4. Distinguish expected business deletion/cancellation from unexpected row disappearance.
5. Do not use `0` as a baseline for a manifest that was unreadable or absent after a prior installation.
6. Ensure safe mode is entered before business routes and before any destructive repair.
7. Expose read-only diagnostics showing exact drops and acceptable explanations.
8. Require an authenticated, audited operator action to accept a new baseline.
9. Require explicit reset/restore operation ID before bypassing the guard.
10. Ensure a failed manifest write cannot silently convert the next boot into a first install.

**Completion proof:** simulate row collapse, tenant mismatch, corrupt manifest, restore baseline, intentional reset, and normal cancellation; only authorized transitions leave safe mode.

---

## IMP-004 — Automatic pre-operation snapshot and backup tool availability

**Status:** NOT PROVEN. Backup code exists; desktop bundled tool availability and reliable snapshots are not established.

**Critical current-tree gap:** `backend/src/infrastructure/backup/backupScheduler.ts` currently writes/removes a `.pending` marker and logs `AUTO_BACKUP_DUE`; it does not create a backup artifact. It also cannot be considered successful merely because a due marker was written. The scheduler must call a shared internal backup/archive service directly (not an HTTP self-call), and must persist `lastSuccessfulBackupAt` only after the archive, checksum, filesystem files, and verification all succeed. The backup route must use the same service so route and scheduler cannot diverge.

Before any of these operations:

- migration;
- desktop update;
- factory reset;
- restore;
- schema repair;
- tenant rebind;

perform a verified snapshot.

Implementation requirements:

1. Bundle and validate `pg_dump` with the exact PostgreSQL major version, or implement an equivalent safe database-level export that includes all required state.
2. Write backup to a separate, non-`pgdata` location with operation ID.
3. Include database dump, JSON metadata, row counts, schema fingerprint, manifest, sync state, and document/attachment files. The PostgreSQL dump and filesystem documents must be captured under one operation ID; define crash consistency (quiesce writes or use a coordinated snapshot protocol) so the database cannot reference files that are absent from the same backup.
4. Encrypt backup artifacts at rest, define key custody/rotation/recovery, check free space and quota before starting, fsync/close temporary files, atomically publish only after all parts and checksums verify, and never expose secrets in backup logs.
5. Reject the operation if snapshot creation or verification fails. A `.pending` marker is not a backup and must never update the successful-backup timestamp.
6. Retain bounded pre-operation snapshots according to an approved RPO/retention policy; never delete the last known-good verified snapshot.
7. Never use the clean packaged template as a backup.
8. Never overwrite the only prior snapshot.

**Backup completeness:** a table query error is an error, not an empty table. Missing tables are allowed only when the schema fingerprint proves they are not part of that version.

**Completion proof:** interrupt snapshot, fill disk, remove pg_dump, corrupt archive, and inject query failure; each blocks the destructive operation and leaves the original data untouched.

---

## IMP-005 — Safe backup/restore protocol

**Status:** CONFIRMED RISK. `restore-from-backup.mjs` begins a tenant wipe before inserts. Warnings and skipped rows must be fatal unless explicitly approved.

**Required protocol:**

1. Parse and validate backup manifest before connecting to target.
2. Reject non-empty `warnings`, unknown schema version, tenant mismatch, checksum mismatch, incomplete table set, or missing required files.
3. Restore first into a disposable staging database.
4. Compare expected/actual counts and per-table checksums.
5. Run financial and sync integrity audits.
6. Verify sequences after explicit-ID inserts.
7. Verify attachments and document files separately.
8. Verify outbox pending/pushing count, inbox cursor, tombstones, conflicts, claims, number blocks, and device identity.
9. Only after staging verification and explicit confirmation may target replacement occur.
10. Prefer atomic database replacement or a transaction with a clearly defined rollback point; do not leave a wiped target after a partial restore.
11. Preserve the append-only ledger trigger and verify it after restore.
12. Record restore operation ID, source, target, counts, warnings, and operator.
13. For cross-hub restore, require cursor/bootstrap policy; never silently reuse a foreign cursor.

**Completion proof:** restore a valid backup, incomplete backup, backup with one skipped row, wrong tenant, corrupted payload, missing attachment, and foreign hub cursor. Only valid restore can be reported successful.

---

## IMP-006 — Full schema fingerprint and migration authority

**Status:** Current working tree contains `schemaFingerprint.ts`, but acceptance is NOT PROVEN.

**Implementation:**

- Generate a versioned expected fingerprint from the migration-built schema.
- Include tables, columns/types/nullability/defaults, indexes/definitions, constraints, RLS enabled/forced state, policies, triggers, functions, enums, extensions, and migration journal.
- Normalize only semantically irrelevant formatting; never normalize away meaningful differences.
- Compare the live database before declaring migrations complete.
- Produce a human-readable diff and machine-readable artifact.
- Fingerprint must be tenant-independent and safe to run read-only.
- Ensure PostgreSQL version/extension requirements are included.

**Canonical authority:** ordered migrations are the change authority; schema declarations are checked against the catalog; desktop template is built from a fully migrated disposable database; no runtime “baseline all” may hide missing DDL.

**Completion proof:** deliberately remove/add/change column, index, constraint, policy, trigger, and function; verifier detects each.

---

## IMP-007 — Remove blind legacy migration baselining

**Status:** CONFIRMED. `runDesktopMigrations.ts` baselines a full journal when `tenants` exists but Drizzle history is empty; `ensureDesktopSchema` is only a wrapper and does not close gaps.

**Safe design:**

- If schema history is absent, first run full schema fingerprint verification.
- Baseline only if the complete expected fingerprint matches.
- If it does not match, fail closed with a support export path.
- Do not replay non-idempotent migrations automatically.
- Provide a separately tested legacy conversion/import tool if old clusters must be supported.
- Never stamp a newer journal index merely because a sentinel column exists.

**Completion proof:** legacy DB at partial migration, complete DB without history, normal DB with history, and corrupt history all behave deterministically.

---

## IMP-008 — Tenant and installation identity consistency gate

**Status:** Tenant is the visibility boundary; multiple tenant sources exist. Fresh/reopen divergence is NOT PROVEN in every desktop path, so verify rather than assume.

At boot/login/restore/sync:

- compare installation ID, db-meta installation ID, selected tenant, database tenant set, JWT tenant, setup tenant, activation tenant, and sync device tenant;
- reject more than one completed desktop tenant unless explicitly supported;
- reject an empty tenant when a prior manifest names a populated tenant;
- do not fall back silently from invalid JWT to build-time/dev tenant in production desktop mode;
- include tenant ID in cache keys and invalidate module-level caches on tenant change;
- require tenant match in backup/restore and device pairing.

**Completion proof:** wrong localStorage tenant, stale JWT, regenerated tenant, multiple tenants, copied AppData, and cross-hub restore all fail safely and diagnostically.

---

# PHASE 1 — Financial Correctness and Auditability

## IMP-009 — Universal financial operation idempotency

**Status:** Some routes use idempotency; settlement and manual ledger paths require explicit coverage. The API must not depend only on a well-behaved frontend.

Apply mandatory operation identity to:

- invoice create/update where retry can reapply a mutation;
- voucher/payment/receipt;
- returns;
- settlement and settle-invoices;
- manual ledger;
- cashbox movements;
- stock mutations;
- sync materialization.

Requirements:

- stable client-generated UUID for one logical operation;
- unique `(tenant_id, operation_id, operation_type)`;
- request fingerprint/body hash to reject reuse with different payload;
- durable status (`processing`, `succeeded`, `failed`, `expired`) and replayable response;
- atomic claim and business mutation in one transaction where possible;
- safe handling of process crash after business commit but before response;
- retention policy with audit evidence, not only a five-minute cache.

**Must remain unchanged:** different operation IDs remain different legitimate operations.

**Tests:** same key concurrent, same key after timeout, same key with changed body, different keys, crash at each mutation stage, multi-process/replica.

---

## IMP-010 — Monetary normalization and invariant audit

**Status:** Header discount/tax/shipping/paid and line discount precision require an explicit policy. Current database scale and calculation normalization can diverge.

Before tightening validation:

1. Audit real historical invoices and sync payloads in a disposable copy.
2. Report values with more than allowed precision and potential persisted-total drift.
3. Decide reject versus normalize for new writes and replay.
4. Define rounding order per currency and operation.
5. Apply the same normalization in shared schema, domain formula, backend validation, persistence, sync replay, reports, and print DTOs.
6. Add invariant checks after persistence:
   - line totals;
   - subtotal;
   - discount/tax/shipping;
   - total;
   - paid/credit applied;
   - base equivalents;
   - settlement allocation.

**Must remain unchanged:** tax/discount/FX/business formulas unless an approved business decision changes them.

**Tests:** half-cent boundaries, negative/zero, multi-currency, returns, partial payments, overpayments, cancellation, replay, database round-trip.

---

## IMP-011 — Universal ledger integrity and reconciliation

**Status:** Use-case balancing exists; all repository/route/materialization paths are not proven equivalent.

Implement:

- balanced per-currency batch validation at repository boundary;
- database constraints where expressible without preventing valid multi-row batches;
- immutable batch/reference IDs;
- no direct unbalanced insert helper exposed to application code;
- read-only integrity audit for every posted batch;
- orphan invoice/ledger/payment/return checks;
- cancellation reversal completeness checks;
- cross-currency separation checks.

**Completion proof:** every write path, including direct repository test, API, sync materialization, restore, and import either creates a valid balanced batch or rolls back.

---

## IMP-012 — Preserve audit history for corrections and deletions

**Status:** Main ledger cancellation is append-oriented; all business entities and manual cash movements need policy review.

Define per document type:

```text
editable draft
→ posted immutable
→ correction/reversal/void
```

For posted invoices, payments, returns, ledger entries, and cashbox movements:

- do not destructive-delete historical truth;
- create reversal/correction references;
- record actor/time/reason/operation ID;
- preserve original document and source rows;
- ensure reports use active/reversed semantics consistently.

If a business requirement genuinely permits deletion, document retention and audit implications and add an immutable audit record.

---

## IMP-013 — Automated financial reconciliation service

Add an explicit read-only integrity command/API and scheduled report:

- ledger debits = credits by batch/currency;
- invoice totals equal normalized components;
- invoice paid equals payment allocations under business rules;
- returns do not exceed eligible original quantity/value;
- stock state equals movement-derived state within defined exceptions;
- cashbox balance equals ledger/manual/session formula per currency;
- customer credit equals its authoritative ledger formula;
- sync-applied operation count and business references agree;
- no orphan rows or cross-tenant foreign references.

The service must produce deterministic JSON/CSV evidence and never silently repair.

---

# PHASE 2 — Transactions, Locks, Sync, and Offline Safety

## IMP-014 — Transaction boundary inventory

Create a reviewed table for every mutation route:

| Route/use case | Transaction owner | Rows read/locked | Rows written | External calls | Outbox atomic? | Idempotency | Rollback test |
|---|---|---|---|---|---|---|---|

Enforce:

- no remote HTTP inside financial transactions;
- no printing inside financial transactions;
- no unbounded report calculation while locks are held;
- all outbox writes join the business transaction;
- nested repositories use ambient transaction/savepoint semantics deliberately;
- transaction isolation and lock timeout are documented.

---

## IMP-015 — Deterministic global lock ordering

**Status:** Opposite input order can deadlock roll locks.

Implement one reusable helper that:

1. validates tenant and duplicate IDs;
2. sorts all resource IDs deterministically;
3. locks all required rows in one query with `FOR UPDATE`;
4. detects missing rows;
5. returns a map for later validation/update;
6. preserves optimistic version checks.

Apply to invoice create/update, returns, inventory adjustments, reservations, and every similar `.for("update")` loop.

Define and document a broader lock order for invoice/party/roll/ledger/cashbox/outbox resources. Add deadlock tests with simultaneous opposite-order transactions.

---

## IMP-016 — Atomic outbox claim with lease ownership

**Status:** Existing repository has lease fields in the working tree, but complete atomic claim/stale-worker behavior is NOT PROVEN.

Required state transition:

```text
pending
→ pushing(owner, token, until)
→ synced/rejected/pending
```

Claim in one transaction/statement using `FOR UPDATE SKIP LOCKED` or an equivalent atomic `UPDATE ... RETURNING`.

Every terminal update must include:

```text
id + tenant_id + lease_token + expected status
```

A stale worker must not be able to mark a row synced/rejected after a new worker reclaims it.

Keep ordering by monotonic `seq`, but do not assume `RETURNING` order.

**Tests:** two claimers get disjoint rows; old token terminal update affects zero rows; lease expiry recovery; process kill after claim; retry after hub timeout; tenant isolation.

---

## IMP-017 — Server-side sync-run exclusion and pull cursor serialization

The browser `running` flag is not sufficient for multiple tabs, processes, users, or manual/periodic overlap.

Implement per-tenant/device server-side exclusion with a lock held on a dedicated connection for the entire critical orchestration. If the lock is unavailable, return a clear skipped result. Ensure pull cursor updates are serialized and monotonic.

Do not use a lock that is released when a pooled connection returns before the work finishes.

---

## IMP-018 — Sync semantics, conflicts, dead letters, and financial reconciliation

State the guarantee precisely:

```text
at-least-once delivery + idempotent materialization keyed by tenant/op_id
```

For each sync operation define:

- dependency ordering;
- duplicate handling;
- conflict policy;
- tombstone policy;
- retryability;
- dead-letter action;
- financial reconciliation;
- operator visibility;
- recovery after long offline period.

A hub dead letter must not leave an unexplained local financial document. Provide a reconciliation workflow that can mark, compensate, retry, or explicitly accept divergence with an audit record; never silently roll back financial truth.

---

## IMP-019 — Sync retention, snapshot, and bootstrap

Device-side synced outbox retention may be implemented after a verified age policy. Hub inbox deletion must wait for a snapshot/bootstrap design.

Ten-year design:

1. Generate consistent tenant snapshot at sequence S.
2. Register snapshot metadata/checksum.
3. New/reset devices bootstrap snapshot then pull events after S.
4. Track the minimum safe cursor across active devices and recovery policy for absent devices.
5. Archive immutable historical events separately.
6. Compact only events proven included in a recoverable snapshot.
7. Test a device absent for months/years, a revoked device, a new device, and a restored device.

No compaction may occur solely because a table is large.

---

# PHASE 3 — Data Completeness and Read Performance

## IMP-020 — Remove “1,000 means all” assumptions

**Status:** Confirmed in multiple frontend calls. Backend pagination itself is valid; consumers are incomplete.

Audit all broad calls in `src/`, including parties, inventory, reports, ledger, vouchers, returns, receipts, payments, tracking, and party details.

Preferred design:

- server-side typeahead for large masters;
- page/cursor APIs for screens;
- date-scoped server aggregates for reports;
- by-ID/batched lookups for historical labels;
- explicit `hasNext` handling;
- no hidden hard ceiling that silently omits records;
- visible warning if a deliberate export limit is reached.

Avoid loading 20,000 masters into browser memory as the final solution.

**Tests:** >1,000 old in-stock rolls; >1,000 parties; report totals against SQL; historical detail lookup; tenant/cache switch.

---

## IMP-021 — Server-side party balances and report aggregation

Move historical balance/report computation from React loops into parameterized backend queries/use cases.

Party balance result must be per currency and match the statement endpoint under:

- active/cancelled entries;
- sales/purchases;
- returns;
- vouchers/settlements/discounts;
- opening balances;
- FX/base values;
- date ranges;
- customer and supplier sign conventions.

For sales, returns, expenses, top fabrics, top customers, and cash reports, create date-scoped aggregate contracts. Keep detail drill-down paginated.

Add JS-vs-SQL parity tests during migration, then remove browser-wide historical arrays.

---

## IMP-022 — Dashboard redesign without changing KPI meaning

Current dashboard has high query fan-out, all-time scans, application filtering, and a no-session currency-mixing risk.

Implementation order:

1. Write a KPI contract: exact date window, status, currency, return kind, cancellation rules, and source tables.
2. Fix no-session cash to return per-currency values or a clearly defined session-currency scalar; never sum currencies.
3. Filter manual movements in SQL.
4. Add returns lookup index only after catalog verification.
5. Rewrite repeated correlated return aggregates into grouped joins where results remain identical.
6. Push top-N grouping into SQL while preserving the explicitly approved all-time/window meaning.
7. Parallelize only independent queries on safe pool connections; do not run concurrent queries over one transaction client.
8. Add query count/timing instrumentation.

Do not change a KPI’s business window merely for performance without approval.

---

## IMP-023 — Query/index program driven by EXPLAIN

Candidate work requires a representative disposable dataset and `EXPLAIN (ANALYZE, BUFFERS)`:

- returns by original invoice/status/kind;
- manual movements by tenant/currency/date;
- invoice list order/filter;
- invoice search;
- statement party/date/currency;
- dashboard unpaid/top/report paths;
- ledger cash paths.

For every index record:

- exact query;
- expected selectivity;
- column order rationale;
- partial/full choice;
- write/storage cost;
- duplicate-index analysis;
- before/after plan and p95.

Reconcile Drizzle declarations with catalog. `idx_invoices_party_date` is currently a schema/catalog drift candidate and must be either created by migration or removed after query evidence.

Do not add `pg_trgm` or keyset pagination solely from theory; measure first while retaining a design path.

---

## IMP-024 — Search correctness and scalability

Escape `%` and `_` when substring semantics are intended. Audit every `ilike` site, not only invoices.

Then measure:

- empty search;
- one-character search;
- common term;
- rare term;
- escaped metacharacter;
- 10K/100K rows;
- warm/cold cache.

If plans require it, add trigram indexes/extensions with migration privilege verification. Preserve existing substring semantics unless a business decision approves prefix/full-text behavior.

---

## IMP-025 — Invoice update query reduction

Batch and deterministically lock all rolls, fetch needed color/fabric relationships in one bounded query, validate in memory, then write updates/movements in batches where atomicity and audit semantics remain identical.

Do not weaken stock version checks, line validation, or movement audit. Measure statement count and transaction duration before/after.

---

## IMP-026 — Frontend request cancellation, cache authority, and tenant scope

For read paths only, propagate `AbortSignal` from React Query through use cases, repositories, API services, and HTTP client. Mutations must not be aborted after the server may have committed unless operation idempotency makes the behavior explicit.

Remove or formalize module-level caches beside React Query:

- one source of truth;
- tenant in every key;
- reset on tenant/logout/activation change;
- bounded cache size/age;
- no stale cross-tenant arrays;
- stable memo dependencies.

Add tests for rapid search changes, tenant switch, logout/login, aborted request, and stale response ordering.

---

# PHASE 4 — Long-Term Operations and Maintainability

## IMP-027 — Database growth and archive strategy

Decide whether `ledger_entry_archive` and `yearly_party_summaries` are:

- reserved and documented;
- fully wired with reconciliation;
- or removed through a safe migration.

Do not call an unused table an archival strategy.

If archiving is required:

- define immutable cutoff;
- preserve IDs/references;
- include archived rows in audits/reports;
- snapshot/reconcile before and after;
- support restore and legal retention;
- test multi-year statements and cross-year corrections.

---

## IMP-028 — Retention policies

Define and implement policies for:

- synced device outbox rows;
- audit logs;
- print jobs;
- attachments/PDFs;
- application logs;
- idempotency rows;
- sync conflicts/tombstones;
- backups/snapshots;
- temporary exports.

Every policy needs owner, age/size threshold, safety predicate, batch size, metrics, dry-run mode, and restore/audit implications.

Never delete pending/pushing outbox rows, unprocessed inbox rows, claims, tombstones, or required audit records merely because they are old.

---

## IMP-029 — Observability and operational SLOs

Add metrics/logs for:

- boot decision and data-safe mode;
- migration duration/failure;
- backup success/failure/bytes/checksum;
- restore verification;
- database size/WAL/autovacuum/bloat where available;
- pool active/idle/wait/error;
- query latency and rows;
- lock waits/deadlocks;
- API p50/p95/p99;
- response/request bytes;
- sync backlog count/age, throughput, retries, conflicts, dead letters;
- memory/RSS/CPU;
- filesystem usage;
- license/device/auth failures.

Never log secrets. Define alert thresholds and operator runbooks.

---

## IMP-030 — Packaging and reproducible desktop release

Verify source → build → stage → package → install → migrate → run → update → uninstall/reinstall.

Required artifacts:

- exact Node/PostgreSQL versions;
- migration journal/fingerprint;
- bundled `pg_dump` if snapshots use it;
- frontend/static resources;
- permissions/capabilities;
- license public key;
- fonts/icons/printing resources;
- manifest checksums;
- clean-install and upgrade installer tests.

NSIS/current-user behavior must preserve AppData by policy. Uninstall must not delete customer data unless an explicit, clearly labeled data-wipe action is selected.

---

## IMP-031 — Contract authority and runtime validation

Unify or explicitly generate frontend/backend contracts for:

- invoice types/statuses;
- party statuses;
- ledger types;
- error envelope;
- cashbox response union;
- report DTOs;
- dates/numbers/currency;
- sync operation payloads.

Remove unchecked `as unknown as` boundary casts where practical. Validate wire responses at the API boundary and return structured contract errors. Add consumer/provider tests for every critical endpoint.

Do not perform a broad rewrite merely to remove type duplication; prioritize concrete mismatches and unvalidated boundaries.

---

## 6. Testing and Verification Blueprint

### 6.1 Financial correctness matrix

Use property and live-PostgreSQL tests for:

- invoice line/subtotal/discount/tax/shipping/total;
- 0/negative/large/precision-boundary amounts;
- SYP/USD/EUR and frozen FX;
- partial/full/over/under payment;
- customer credit applied/spent/cancelled;
- returns and prior-return caps;
- COGS/profit;
- cashbox and ledger per currency;
- cancellation/reversal idempotency;
- concurrent same-document and same-stock writes;
- restore/replay equivalence.

### 6.2 Concurrency matrix

Run true simultaneous barriers, not sequential calls:

- same idempotency key;
- different operation IDs same invoice/roll;
- opposite roll order;
- two sync claimers;
- expired lease and new worker;
- two pullers/cursor updates;
- payment timeout/retry;
- app termination at each transaction phase;
- two tenants concurrently using the same server.

Assert no duplicate financial effect, no lost event, no cross-tenant row, no negative/over-reserved stock, balanced ledger, and deterministic terminal state.

### 6.3 Upgrade matrix

For every supported historical release/schema state:

1. Create disposable DB with realistic amplified data.
2. Record counts, checksums, tenant/device IDs, schema fingerprint, and financial audit.
3. Install/update current desktop over copied AppData.
4. Interrupt migration/update at controlled points.
5. Restart and recover.
6. Verify counts, checksums, references, balances, stock, sync cursors, files, and logs.
7. Verify no clean template was selected over an existing installation.

Scenarios must include missing/partial `pgdata`, db-meta combinations, missing migration history, failed DFP migrations, old secrets/device binding, uninstall/reinstall, factory reset, backup restore, and cross-hub restore.

### 6.4 Scale matrix

Datasets:

- invoices: 2K, 10K, 50K, 100K;
- lines per invoice: 1, 5, 10, 25, 50, 100;
- ledger/voucher/stock/audit/sync amplification recorded;
- parties/products/rolls varied independently.

Operations:

- cold/warm startup;
- invoice list/search/deep page;
- invoice open/create/update;
- dashboard;
- reports/statements/profit;
- inventory/product search;
- payment/settlement;
- printing/export;
- sync drain 1K/10K/100K/1M events;
- restart and recovery.

Concurrency: 1, 8, 32, 64, 128 bounded workers where safe.

### 6.5 Required measurements

Every benchmark records:

- git SHA and dirty-tree state;
- OS/hardware/runtime versions;
- PostgreSQL version/config;
- pool size;
- dataset manifest/seed;
- query count/time and plan;
- p50/p95/p99;
- response/request/IPC bytes;
- CPU/RSS;
- DB size/WAL/index size;
- pool wait/locks/deadlocks;
- sync backlog/age/throughput/retries/conflicts;
- errors and retries.

No proposed threshold may be presented as measured.

---

## 7. Release Gates

### Gate A — Data safety

Must pass before customer pilot:

- missing pgdata fails closed;
- boot decision is durable;
- manifest safe mode works;
- schema fingerprint detects drift;
- blind baseline removed;
- pre-operation snapshot succeeds/fails closed;
- restore rejects warnings and passes staging verification;
- tenant identity gate passes;
- no secret leakage in logs;
- upgrade matrix passes.

### Gate B — Financial and sync correctness

- all financial POST routes have durable idempotency;
- ledger audit passes;
- money normalization policy and historical audit complete;
- lock-order race passes;
- outbox claims are disjoint;
- stale worker cannot overwrite new worker;
- cursor recovery passes;
- dead-letter reconciliation is explicit;
- no cross-tenant or duplicate financial effect.

### Gate C — Read correctness/performance

- no broad consumer assumes `limit=1000` means all;
- party balances equal statements across currencies/cases;
- reports equal SQL/reference totals;
- dashboard does not blend currencies;
- search semantics and plans verified;
- p95/p99 gates approved and passed at declared dataset sizes;
- memory and response-size limits are bounded.

### Gate D — Ten-year operations

- backup schedule and restore drill pass;
- RPO/RTO are documented and measured;
- retention jobs are safe/dry-runnable;
- sync snapshot/bootstrap/compaction design is implemented before hub deletion;
- archive/reconciliation strategy exists;
- upgrade/rollback support is documented;
- operational alerts/runbooks exist;
- packaged clean install and upgrade pass on supported Windows versions.

---

## 8. Implementation Order

1. Freeze and record the current working tree; do not mix audit artifacts with unrelated feature work.
2. Implement durable boot logging and data-integrity state transitions.
3. Implement fail-closed missing-data and tenant/schema gates.
4. Add verified pre-operation backup/snapshot tooling, including required bundled tools.
5. Make restore staging-first and warnings-fatal.
6. Remove blind migration baselining; add full schema fingerprint verification.
7. Add universal financial idempotency and operation identity.
8. Add precision audit/normalization policy and ledger reconciliation.
9. Implement deterministic locks and atomic sync leases/tokens/run exclusion.
10. Add sync failure reconciliation and recovery tests.
11. Move party/report calculations to server aggregates; remove silent completeness assumptions.
12. Correct dashboard currency/query behavior and add evidence-driven indexes.
13. Add cancellation-aware reads and tenant-safe bounded caches.
14. Establish retention/archive/snapshot strategy.
15. Build the scale harness and run baseline/after-repair measurements.
16. Execute the complete upgrade/install/restore/recovery matrix.
17. Only then produce a release candidate and release evidence bundle.

Do not reorder Phase 0 behind performance work. A fast system that can silently open an empty customer database is not acceptable.

---

## 9. Human Decisions Required Before Implementation

1. Is negative cash balance explicitly allowed for every cashbox operation and currency, with warning only?
2. What are official precision and rounding rules per currency and tax/discount operation?
3. Should inactive parties remain selectable in new documents?
4. What report windows are official for top-fabric/top-customer KPIs?
5. What should a no-session multi-currency dashboard expose: map, null scalar, or selected default currency?
6. Is the difference between sale-return filtering and profit-debt filtering intentional?
7. What is the supported oldest schema/release for automatic upgrade?
8. What is the recovery path for legacy databases with missing migration history?
9. Should an operator be able to explicitly start empty after a missing database, or must support/restore intervene?
10. What local/off-device backup retention and encryption policy is required?
11. What are RPO/RTO targets?
12. What sync event retention and hub snapshot policy is acceptable?
13. Which archive tables are authoritative, reserved, or removed?
14. What p95/p99 and resource limits define pilot and production readiness?
15. What data sizes and concurrency levels are supported contractually?
16. Which PostgreSQL extensions and privileges are guaranteed on desktop and hub?
17. Which clients must be supported for idempotency/contract compatibility?
18. What legal/audit retention rules apply to ledger, invoice, audit, and document files?
19. Is the current uncommitted working tree an intentional implementation branch or must it be split before release?

Each decision must be recorded with owner, date, rationale, affected invariants, migration impact, and test requirement.

---

## 10. Completion Definition

An improvement is not complete when code compiles. It is complete only when all applicable evidence exists:

- source implementation;
- migration/schema update if needed;
- unit test;
- integration/live-PostgreSQL test;
- concurrency or recovery test where relevant;
- frontend/API contract test where relevant;
- performance before/after measurement where relevant;
- backup/restore/upgrade evidence where relevant;
- logs/metrics demonstrating operation;
- rollback procedure;
- documentation/runbook;
- clean working-tree review and diff inspection.

A workstream must be marked:

```text
COMPLETE — verified
```

or:

```text
PARTIAL — implementation exists, required evidence missing
```

or:

```text
NOT PROVEN — no safe implementation/evidence yet
```

Never mark “complete” based only on a source-text test or a happy-path unit test.

---

## 11. Final Verdict

The project should preserve its healthy core: transactional business writes, double-entry ledger semantics, append-only financial history, per-currency calculations, stock locking, and durable sync concepts.

The required improvement is not a wholesale rewrite. It is disciplined hardening around the existing core:

```text
protect data first
→ make truth boundaries explicit
→ make mutation identity/idempotency durable
→ make locks and sync ownership race-safe
→ move historical reads to bounded server/database paths
→ measure scale
→ operate backups, upgrades, retention, and recovery as first-class systems
```

The project becomes credible for a long-lived ERP only after the release gates are demonstrated with evidence. Until then, the honest classification is:

```text
Strong accounting/application foundation.
High data-lifecycle and operational risk.
Performance/scalability not yet measured.
Desktop upgrade safety not yet proven.
Ten-year durability not yet proven.
```
