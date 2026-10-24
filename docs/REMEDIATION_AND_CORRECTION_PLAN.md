# REMEDIATION AND CORRECTION PLAN

**Subject:** Google Drive Cloud Archiving · Automated Monthly Document Generation · Smart Non-Destructive Merge Restore (Reconciliation)

**Origin:** Independent Forensic Audit — Architectural Validation & Implementation Reality Check
**Audit score:** **45 / 100**
**Baseline commit:** `ec8dde8a` ("chore: prepare v3.0.6 release")
**Working tree:** 37 modified + 17 untracked files (54 entries) — **entirely uncommitted**
**Auditor:** Principal Systems Architect (independent, no prior involvement)
**Document status:** Masterfile — authoritative remediation roadmap. No application source code was modified in producing it.

---

## EXECUTIVE SUMMARY

The audit established that the three headline deliverables are in **radically different states of reality** than the plan document's framing implies:

| Deliverable | Reality | Stage |
|---|---|---|
| **1. Drive Cloud Archiving** | ~70% real. OAuth/PKCE, DPAPI token sealing, folder hierarchy, lease-protected queue all work. Identity key is **filename-derived** → duplicates on rename/cancel, silent loss on collision. Content is still **CSV only**. | Stage 2 |
| **2. Automated Monthly Generation** | ~15% functional. Renderer is an **explicit stub returning `Err`**. The 3 new Tauri commands are **ACL-blocked at runtime** and **break the repo's own test**. The Rust scheduler is **never called**. The backend still re-exports **24 months every 6 hours** — there is no monthly schedule. | Stages 1 & 3 |
| **3. Smart Merge Restore** | **0% implemented.** Zero lines of code. The design (the deliverable) is itself **mis-specified** in ways that would corrupt balances if implemented literally. | Stage 4 |

**Seventy-three (73) discrete problems** are catalogued in §1 across nine domains (A–I), each with an exact location, a root-cause trace, and a downstream ripple analysis.

**Two facts dominate the remediation order:**

1. **The repository's own contract test is currently RED.** `desktop-app/scripts/ipc-acl.test.mjs` fails because three commands were registered in `main.rs` without being declared in `build.rs` `APP_COMMANDS` and `capabilities/default.json`. Tauri refuses such commands at runtime. This is a ~10-minute fix that must precede everything else.
2. **The Smart Merge design would corrupt money if implemented as written.** The cashbox replay double-counts against a trigger-maintained cumulative series; the ledger has no natural key, so historical legs double-post with no error; `remaining_pieces` has no audit trail and is unreconstructable; and policy D-7 is unimplementable against a live `UNIQUE` constraint. **Stage 4 is a re-architecture, not an implementation task.**

### Stage Roadmap at a Glance

| Stage | Name | Problems | Exit Gate |
|---|---|---|---|
| **1** | Stop the Bleeding & Green the Repo | A-01…A-03, B-01, B-04, F-01, H-01 | `ipc-acl.test.mjs` green; cancel returns 200; no regressions |
| **2** | Cloud Identity & Deduplication Hardening | C-01…C-13, D-01…D-12 | UUID-keyed upsert proven by a *found→update* test; single scheduler |
| **3** | Complete the PDF/PNG Engine | E-01…E-14 | Real PDF/PNG produced on a physical desktop; no UI freeze |
| **4** | Re-architect Phase 5 Smart Merge | G-01…G-13 | Planner proven on golden fixtures; applier gated behind invariants |

**Stages are strictly ordered.** Stage 2 must not begin until Stage 1's exit gate is green, because Stage 2's work depends on the upload queue being reachable at all. Stage 4 must not begin until Stage 2's identity model is settled, because the merge planner's document keys must match the archive's.

---

## §0 — BASELINE & MEASUREMENT METHODOLOGY

All measurements in this document were produced by running the repository's own tooling against the working tree at `ec8dde8a`. Every command is reproducible.

### 0.1 Verification Commands — Canonical Reference

| Purpose | Command | Source |
|---|---|---|
| Rust shell tests | `cd desktop-app/src-tauri && cargo test -j1` | `CLAUDE.md:29` |
| Rust compile check | `cd desktop-app/src-tauri && cargo check --offline` | — |
| Frontend + shared tests | `npx vitest run` | `CLAUDE.md:23` |
| Backend tests (SQLite) | `cd backend && DB_ENGINE=sqlite npx vitest run` | `CLAUDE.md:24` |
| Backend tests (Postgres) | `cd backend && npm run test` | `backend/package.json` |
| Frontend typecheck | `npx tsc --noEmit` | `CLAUDE.md:26` |
| Backend typecheck | `cd backend && npx tsc --noEmit` | `CLAUDE.md:26` |
| **SQLite schema + fingerprint gate** | `cd backend && npm run typecheck:sqlite` | `CLAUDE.md:26` |
| Lint (0 warnings allowed) | `npm run lint` · `cd backend && npm run lint` | `CLAUDE.md:27` |
| **IPC parity contract test** | `node --test desktop-app/scripts/ipc-acl.test.mjs` | `desktop-app/package.json:11` |
| Desktop script tests | `cd desktop-app && npm test` | `desktop-app/package.json:11` |
| Drift reconciler (read-only) | `node backend/scripts/reconcile-integrity-sqlite.mjs --db <path>` | `backend/scripts/` |
| Ledger integrity (PG) | `node scripts/ledger-integrity-check.mjs` | `scripts/` |

> `CLAUDE.md:33` — *"Never use `vitest --reporter=basic`: it can exit 0 having run nothing. Read the summary line."* This rule applies to every gate in this document.

### 0.2 Protected File Set — Measured Baseline (Correction to Directive Premise)

The directive specifies "the 9 protected invoice/party files … retaining their exact **134/28** diff". **That figure does not reconcile with the working tree.** The measured baseline is:

```
git diff --numstat -- <the 9 files>
```

| # | File | Ins | Del | Category |
|---|---|---:|---:|---|
| 1 | `src/components/invoices/SaleLineCard.tsx` | 5 | 6 | Tier P — business logic |
| 2 | `src/components/invoices/entry-types.ts` | 2 | 1 | Tier P |
| 3 | `src/components/invoices/sale-types.ts` | 2 | 1 | Tier P |
| 4 | `src/components/parties/PartyTable.tsx` | 10 | 7 | Tier P — presentation |
| 5 | `src/routes/invoices.entry.new.tsx` | 5 | 4 | Tier P |
| 6 | `src/routes/invoices.sale.new.tsx` | 6 | 6 | Tier P |
| 7 | `src/routes/cashbox.tsx` | 3 | 1 | Tier P |
| 8 | `src/components/print/blankFirstPage.test.ts` | 7 | 1 | Tier A — archive-adjacent |
| 9 | `src/shared/utils/documentArchive.ts` | 2 | 0 | Tier A — archive-adjacent |
| | **TOTAL** | **42** | **27** | |

- **Tier P (7 files, 33 ins / 26 del)** — the "ISSUE 1 / ISSUE 3" business changes. **Must remain byte-identical.**
- **Tier A (2 files, 9 ins / 1 del)** — the archive-adjacent changes (`documentArchive.ts` business-month threading; `blankFirstPage.test.ts` import-guard rewrite). **Must remain byte-identical** unless Stage 1's F-01 fix requires touching `documentArchive.ts` — in which case the change must be additive only and the numstat re-baselined and recorded in the Stage 1 exit report.

**The enforceable invariant is the measured 42/27, not the directive's 134/28.** Re-verify with:

```powershell
git diff --numstat -- src/components/invoices/SaleLineCard.tsx `
  src/components/invoices/entry-types.ts src/components/invoices/sale-types.ts `
  src/components/parties/PartyTable.tsx src/routes/invoices.entry.new.tsx `
  src/routes/invoices.sale.new.tsx src/routes/cashbox.tsx `
  src/components/print/blankFirstPage.test.ts src/shared/utils/documentArchive.ts
```

For reference, all 14 modified `src/` files total **212 ins / 162 del (374 lines)** — the archive work itself.

### 0.3 Severity Taxonomy

| Level | Meaning | Gate |
|---|---|---|
| **S1 — Critical** | Data corruption, silent financial drift, or a broken repo contract. | Blocks all subsequent stages. |
| **S2 — High** | Feature is non-functional or demonstrably incorrect in normal operation. | Must close before release. |
| **S3 — Medium** | Correctness gap that requires an unusual sequence to surface, or a maintainability trap. | Must close before the owning feature ships. |
| **S4 — Low** | Documentation, hygiene, or cosmetic inconsistency. | Close opportunistically. |

---

## §1 — EXHAUSTIVE PROBLEM CATALOG & IMPACT TRACE

### DOMAIN A — Build, Contract & Permission Integrity

---

#### **A-01 — Tauri IPC command declared in `main.rs` but absent from the app manifest**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `desktop-app/src-tauri/src/main.rs:50-52` · `desktop-app/src-tauri/build.rs:6-25` · `desktop-app/src-tauri/capabilities/default.json:6-26` |
| **Status** | **Live. Repo test is RED.** |

**Exact location**
```rust
// main.rs:50-52 — registered
commands::archive_render_pdf_cmd,
commands::archive_capture_png_cmd,
commands::archive_clear_run_cmd,
```
```rust
// build.rs:6-25 — APP_COMMANDS ends at "save_csv_file"; the three archive commands are ABSENT
const APP_COMMANDS: &[&str] = &[ "api", "get_app_version", …, "save_csv_file" ];
```
```json
// capabilities/default.json — permissions list ends at "allow-save-csv-file"
```

**Root cause**
The previous agent registered three new IPC handlers in `generate_handler!` but did not extend the **three-list parity contract** that this repository enforces by design. `build.rs:1-5` states the rule verbatim:

> *"Every IPC command the shell registers (`generate_handler!` in src/main.rs) is declared here, so each one gets an `allow-<command>` permission, and the window's capability grants exactly these. A command missing from either list is refused by Tauri's ACL at runtime; `scripts/ipc-acl.test.mjs` keeps the three lists and every `invoke()` in the UI and the boot page in step."*

Because `tauri_build::Attributes::new().app_manifest(...)` is set (`build.rs:28-30`), Tauri enables app-command ACL checking. The three commands therefore fail with `Command archive_render_pdf_cmd not allowed by ACL` in release builds.

**Ripple effects & cascading risks**
1. **The repository's own contract test fails** — verified:
   ```
   node --test desktop-app/scripts/ipc-acl.test.mjs
   ✖ the app manifest and the capability list exactly the registered handlers
     AssertionError: build.rs APP_COMMANDS ≠ generate_handler!
       - 'archive_capture_png_cmd', - 'archive_clear_run_cmd', - 'archive_render_pdf_cmd'
   Exited with code 1
   ```
   This is a **CI-breaking regression** on the working tree. `desktop-app/package.json:11` runs it as part of `npm test`.
2. **Every PDF/PNG invocation fails at runtime** in release builds, even after E-01 is fixed. Stage 3 would ship non-functional even if implemented perfectly.
3. The failure mode is **silent in dev/debug builds** (Tauri skips app-ACL checks when no manifest is present), so a developer on a debug build would not see it — meaning Stage 3's "desktop spike" could report success while release is broken.
4. Downstream, the entire Stage 3 verification gate ("produce a real PDF on a physical desktop") is **invalid** unless this is fixed first — a debug-build spike would pass while the release artifact fails.

**Remediation reference:** Stage 1, Task 1.1.

---

#### **A-02 — Capability file `permissions` list out of parity with the manifest**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** (paired with A-01) |
| **Scope** | `desktop-app/src-tauri/capabilities/default.json:6-26` |
| **Status** | **Live. Repo test is RED.** |

**Exact location**
`capabilities/default.json` grants 18 `allow-*` permissions, mirroring `APP_COMMANDS`. `archive-render-pdf-cmd`, `archive-capture-png-cmd`, `archive-clear-run-cmd` are absent. No `permissions/autogenerated/archive_render_pdf_cmd.toml` exists (only 18 legacy autogenerated files).

**Root cause**
Same as A-01 — the capability list is hand-maintained in lockstep with `APP_COMMANDS`, and both were skipped.

**Ripple effects & cascading risks**
`ipc-acl.test.mjs:44-47` asserts **both** `manifest == handlers` **and** `granted == handlers`. Fixing only `build.rs` leaves the test red. The two lists must move together.

**Remediation reference:** Stage 1, Task 1.1 (single atomic edit across both files).

---

#### **A-03 — Hidden render window has no capability grant**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:158-165` · `capabilities/default.json` (`"windows": ["main"]`) |
| **Status** | Latent — masked today by E-01 (the stub never navigates). |

**Exact location**
```rust
// pdf_render.rs:158-165
WebviewWindowBuilder::new(app, &label, WebviewUrl::App("boot.html".into()))
    .visible(false).inner_size(1280.0, 1800.0).build()
```
`label` = `archive-render-<uuid>`. `capabilities/default.json` declares `"windows": ["main"]` — the hidden window matches no capability.

**Root cause**
Tauri grants capabilities by window label. A window whose label matches no capability receives **no IPC permissions at all**. This was not considered because the plan assumed the hidden window would load the SPA route (`PLAN.md:344`), which requires `invoke("api")` to reach the backend — an IPC operation the hidden window cannot perform.

**Ripple effects & cascading risks**
- If Stage 3 implements the plan's design (renderer loads `…/archive-snapshot?period=…`), the hidden webview **cannot call the backend** → the snapshot route renders empty → the PDF is blank or errors, and the failure is not obviously attributable to ACL.
- If Stage 3 instead passes an HTML string (as the current command signature does), this is latent — but the design must still be settled deliberately in Stage 3, not by accident.

**Remediation reference:** Stage 3, Task 3.8 (decision + capability entry).

---

#### **A-04 — `routeTree.gen.ts` regenerated without the TanStack Start footer**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `src/routeTree.gen.ts` (diff: +21 / −10) |
| **Status** | Live; type-only impact (`tsc --noEmit` currently clean). |

**Exact location**
```diff
-import type { getRouter } from './router.tsx'
-import type { startInstance } from './start.ts'
-declare module '@tanstack/react-start' {
-  interface Register { ssr: true; router: …; config: …; }
-}
```
The footer is emitted by `@tanstack/start-plugin-core/start-router-plugin/route-tree-footer.js`.

**Root cause**
The route tree was regenerated with a different tool invocation than the project's own generator (the plan's `PLAN.md:301` asserts "the diff adds only this route" — **false**; the footer was also dropped).

**Ripple effects & cascading risks**
- Type-only today; `src/start.ts` and `src/router.tsx` are still present and used.
- The committed artifact **no longer matches generator output**. The next `vite dev` / `vite build` regenerates it, producing a spurious diff that can mask real changes or be committed accidentally.
- If any code depends on `Register` augmentation (SSR typing), a future strict build could break.

**Remediation reference:** Stage 1, Task 1.6 (regenerate with the project's own generator; verify the diff is additive only).

---

### DOMAIN B — Schema, Constraint & Data-Integrity Defects

---

#### **B-01 — `cancelled` run state violates the `motard_drive_runs_state` CHECK constraint → cancel returns HTTP 500**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `backend/src/infrastructure/googledrive/archiveRuns.ts:11,24,57-58` · `backend/src/infrastructure/orm/sqlite/migrations/0005_drive_archive.sql:76` · `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:254-268` · `backend/src/presentation/routes/drive.route.ts:231-239` |
| **Status** | **Live production bug. Reproducible.** |

**Exact location**
```sql
-- 0005_drive_archive.sql:76
CONSTRAINT "motard_drive_runs_state" CHECK ("state" IN ('running', 'done', 'failed', 'partial'))
```
```ts
// archiveRuns.ts:11
export type RunState = "running" | "done" | "failed" | "partial" | "cancelled";
// archiveRuns.ts:58
if (p.cancelRequested) return "cancelled";
```
```ts
// monthlyArchiveJob.ts:254-263
const endState = finalState(progress, attempted);
finishLiveRun(run.id, endState, progress);
await db.update(motardDriveRuns).set({ state: endState, finishedAt: nowIso(), detail: encodeDetail(...) })
  .where(eq(motardDriveRuns.id, run.id));
```

**Root cause**
**A type-system / database-schema contract divergence.** The TypeScript `RunState` union was extended with `"cancelled"` but the SQL CHECK constraint that governs the same column was never extended. The compiler cannot see across the Drizzle boundary, and no test exercises the cancel → persist path against a real schema (the `motard_drive_runs` table is created by the raw `.sql` migration applied by `backend/scripts/migrate.mjs:36`, so the CHECK is live).

**Ripple effects & cascading risks**
1. The `UPDATE` raises `CHECK constraint failed: motard_drive_runs_state`, caught by the outer `catch` at `monthlyArchiveJob.ts:264-269`, which **rewrites the run state to `"failed"` and rethrows**.
2. `POST /api/drive/archive/runs/:id/cancel` → the rethrow propagates → the client receives **HTTP 500 SYNC_FAILED** instead of a successful cancellation.
3. **The audit trail lies**: a user-requested cancellation is recorded as a **failure**, permanently corrupting the operational history of every run the user ever cancels.
4. The in-memory live-run map (`finishLiveRun(run.id, endState, progress)`) is updated *before* the DB write, so the in-memory view reports `"cancelled"` while the DB says `"failed"` — **two sources of truth diverge**, and `GET /drive/archive/runs/:id` (which reads only the in-memory map) will report a state that the durable record contradicts.
5. Once Stage 3/D-09 make run progress a user-visible feature, users will hit this routinely.

**Remediation reference:** Stage 1, Task 1.2 (schema-first fix via a new `0007` migration — **not** by removing `"cancelled"` from the TS union, which would discard the user's intent).

---

#### **B-02 — `motard_drive_runs` missing `period_key` / `trigger` / progress columns; progress smuggled into a JSON blob**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/orm/sqlite/migrations/` (no `0007_drive_archive_runs.sql`) · `backend/src/infrastructure/googledrive/archiveRuns.ts:5-6, 82-119` · `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts:64` |
| **Status** | Live. |

**Exact location — the full migration inventory**
```
0000_baseline.sql   0001_statement_lookup_indexes.sql   0002_sync_restore_state.sql
0003_roll_entry_price_invoice_pieces.sql                0004_party_opening_currency.sql
0005_drive_archive.sql                                 0006_day_closes_per_currency.sql
```
**There is no `0007`.** The plan required it (`PLAN.md:366-370`, deliverable at `PLAN.md:557`):
> `motard_drive_runs` (existing, `0005`): add `period_key TEXT`, `progress_done INTEGER DEFAULT 0`, `progress_total INTEGER DEFAULT 0`, `current_file TEXT`, `trigger TEXT`

Only `period_key` exists (from `0005`), and it is **never populated** (`monthlyArchiveJob.ts:157-160` inserts `{ id, kind: "catchup", state: "running", startedAt }` with no `periodKey`).

**Root cause**
The implementer chose the path of least resistance — packing progress into the existing free-form `detail` JSON column (`archiveRuns.ts:5-6`: *"so the existing `motard_drive_runs` table carries it without a schema change"*) — rather than executing the migration the plan had already specified. The SQLite schema is **generated** from a generator source (`scripts/generate-sqlite-schema.mts`), so a schema change also requires updating the Drizzle schema file and regenerating `0000_baseline.sql` + `meta/schema-fingerprint.json`.

**Ripple effects & cascading risks**
1. **Progress is not queryable.** `GET /drive/archive/runs/:id` reads only the in-memory map — after a backend restart the run 404s even though a DB row exists (see D-09).
2. **No durable "period already archived" marker.** Without a populated `period_key` + a `done` state, the scheduler cannot answer "which periods are covered?" — which is the direct cause of D-02 (24-month × 6-hour rescan).
3. `kind` is hard-coded `"catchup"` for **every** run, including manual and (intended) monthly — so the run history cannot distinguish trigger types.
4. `meta/schema-fingerprint.json` drift → `npm run typecheck:sqlite` fails once a migration is added without regenerating the fingerprint.

**Remediation reference:** Stage 1, Task 1.3 (migration) — needed by Stage 2's scheduler consolidation (D-02).

---

#### **B-03 — `motard_drive_uploads.revision` is dead schema**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** |
| **Scope** | `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts:48` |
| **Status** | Live — column never written or read. |

**Root cause / ripple** — A column declared in the Drizzle schema but never populated by any code path. Harmless today, but it is a trap: a future implementer may assume it carries a revision counter for optimistic concurrency when it is always `NULL`/default. Either populate it meaningfully or drop it in the next `0007` migration.

**Remediation reference:** Stage 2, Task 2.9 (decide with the column's owner).

---

#### **B-04 — Cashbox snapshot renders every outflow as `0.00`**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `src/routes/archive-snapshot.tsx:62-63` |
| **Status** | Live. Latent today (route is dead code — E-12), but becomes a **visible financial misstatement** the moment Stage 3 wires the renderer. |

**Exact location**
```tsx
// archive-snapshot.tsx:62-63
cashIn:  e.cashImpact === "in"  ? Math.abs(Number(e.debit ?? e.credit ?? 0)) : 0,
cashOut: e.cashImpact === "out" ? Math.abs(Number(e.debit ?? e.credit ?? 0)) : 0,
```

**Root cause**
**Nullish-coalescing on a non-nullable column.** For a cash-out leg the amount resides in `credit`; `debit` is `0` — a *defined* value, not `null`/`undefined`. `??` only falls through on nullish, so `debit ?? credit` evaluates to `0` and the outflow is reported as zero. The server-side convention is `COALESCE(debit,0) + COALESCE(credit,0)` (`cashboxBalanceHelper.ts:36-42`) — the client dropped that.

**Ripple effects & cascading risks**
1. **The archived cashbox report understates disbursements** — a financial document that misstates money.
2. The error is invisible in the HTML because the outflow column renders as a legitimate-looking `0.00`; no exception, no test failure, no console warning.
3. Because `buildCashboxBody` **is** exercised by 19 unit tests, the tests pass while the bug lives — the tests assert the builder, not this row-mapping expression.

**Remediation reference:** Stage 1, Task 1.4.

---

#### **B-05 — `invoices.paid` is a stored scalar that drifts from vouchers by construction (pre-existing; merge-critical)**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** *(as a live defect)* · **S1 — Critical** *(as a merge blocker — see G-08)* |
| **Scope** | `backend/src/infrastructure/orm/schemas/invoice.table.ts:40-45` · `SqliteInvoiceRepository.ts:401` · `SqliteVoucherRepository.ts:608-620, 793-795` · `SqliteInvoiceRepository.ts:1641-1644` |
| **Status** | Live, pre-existing. Not introduced by this change set. |

**Exact location**
```ts
// invoice.table.ts:40-45 — stored, not derived
paid: numeric("paid", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
```
```ts
// SqliteInvoiceRepository.ts:401
paid: round2dp(cashApplied + creditApplied),
```

**Root cause**
`paid` was designed as a convenience cache for `amountDue = total - paid`, but it is maintained by **three** independent writers (invoice create, voucher create, voucher cancel) and no trigger, CHECK, or FK ties it to `vouchers`. Three construction-time asymmetries make `paid ≠ Σ voucher.amount` **by design**:
1. `creditApplied` (a customer credit applied at invoice creation) is folded into `paid` but has **no voucher row and no ledger receipt**.
2. Overpayment: `paid` is capped at `total` while the voucher holds the full cash amount.
3. FX: a USD voucher settling a SYP invoice credits the **converted** value (`SqliteVoucherRepository.ts:610-616`), so the sum in invoice currency ≠ the sum in voucher currency.

**Ripple effects & cascading risks**
1. `amountDue` (derived at read, `:1641-1644`) can differ from `total − Σ applied`.
2. **Merge-critical:** the plan's invariant **I-3** ("`paid` equals applied sum") is **already false on healthy production data**. Implemented as a hard gate, it would abort every legitimate merge; implemented as a soft check, it is useless; implemented as a *replay*, it silently redefines `paid` and breaks `amountDue` for every merged invoice.
3. No database guard exists — drift is silent.

**Remediation reference:** Stage 4, Task 4.6 — downgrade I-3 from a *gate* to a *diagnostic with tolerance*, and **never replay `paid`**.

---

### DOMAIN C — Cloud Identity, Deduplication & Network Robustness

---

#### **C-01 — Drive upsert key is derived from the filename, i.e. from mutable business data**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `backend/src/infrastructure/googledrive/uploadQueue.ts:74-86` · `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:171-181` · `backend/src/infrastructure/googledrive/exporters.ts:94-107` · `packages/shared/src/archivePaths.ts:128-132` |
| **Status** | Live. Plan acknowledged at `PLAN.md:231` and deferred it. |

**Exact location**
```ts
// uploadQueue.ts:80-86
export function documentKey(job): string {
  return appKey({
    tenantId: "archive",
    docType: `${job.section}:${job.entityType}`,
    documentId: `${job.periodKey}:${job.entityId}`,
  });
}
```
```ts
// monthlyArchiveJob.ts:171-181
entityId: f.fileName, // deterministic filename is the stable identity
```
```ts
// exporters.ts:94-107 — the filename is built from MUTABLE fields
fileName: `${r.date}_${r.number}_${party || "بدون-اسم"}${cancelled ? "_ملغاة" : ""}.csv`,
```

**Root cause**
The identity of a business document was conflated with its **human-readable rendering**. The plan's own D-6 decision states the correct principle — *"Drive `appProperties.motardKey` = `appKey(meta)` (type + tenant + document id). Renaming a party must not create a duplicate"* — but the implementation keys on the filename instead of the document id. `invoices.id` **is** selected at `exporters.ts:83` and then **discarded**.

**Ripple effects & cascading risks**

| Live change | Filename changes? | Drive outcome |
|---|---|---|
| Total / paid / status `active` | no | in-place `updateMedia` ✔ |
| Party renamed | yes (`_زبون`→`_زبون2`) | **new Drive file**; stale original remains ✘ |
| Invoice cancelled | yes (`_ملغاة` suffix) | **new Drive file**; stale original remains ✘ |
| Invoice number or date edited | yes | **new file**; old one orphaned in the old month folder ✘ |
| Two invoices, same date+number+party | n/a | **NOT REACHABLE — corrected in Stage 2.** `invoices` carries `UNIQUE (tenant_id, type, number)`, so two invoices cannot share a number and the file names cannot collide within a section. The original audit claim of a "silently lost invoice" was WRONG. The rename / cancel / renumber duplicates above are real. |
| The invoice's **number** is edited | yes | new file; the old one orphaned ✘ (fixed in Stage 2: the key is the document's immutable id) |

The last row is the most severe: the archive **silently loses an invoice** with no error anywhere.

**Remediation reference:** Stage 2, Task 2.1.

---

#### **C-02 — `invoices.id` selected then discarded in the exporter**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** (enabler for C-01) |
| **Scope** | `backend/src/infrastructure/googledrive/exporters.ts:83` |
| **Status** | Live. |

**Exact location**
```ts
// exporters.ts:83
id: invoices.id,
```
The identifier is fetched and never propagated to the queue row.

**Root cause** — the DTO shape mirrors the CSV column set rather than the archive's identity needs.

**Ripple effects** — the stable UUID needed for C-01's fix is present in memory and thrown away; a fix must thread it through `monthFiles` → `queue.enqueue` → `documentKey`.

**Remediation reference:** Stage 2, Task 2.1.

---

#### **C-03 — `findByAppKey` lookup is scoped to the parent folder**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts:186-196` · `uploadQueue.ts:271` |
| **Status** | Live. |

**Exact location**
```ts
// driveClient.ts:186-196
const q = `appProperties has { key='motardKey' and value='${escaped}' } and trashed = false${parentClause}`;
```

**Root cause**
The `appProperties` query is globally unique by construction (the key embeds the document id), but the implementation additionally constrains `'<parentId>' in parents`. The scoping was presumably added to keep the query cheap.

**Ripple effects** — if a year/month/category folder is ever recreated (drive rename, manual tidy, a new company name, a deleted-and-recreated month), the same key in the new folder is **not found** → a **duplicate file** is created, and the old one is orphaned. This silently defeats the upsert guarantee in exactly the situations where it matters most.

**Remediation reference:** Stage 2, Task 2.3.

---

#### **C-04 — `updateMedia` replaces bytes but never updates the Drive filename or `modifiedTime`**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts` (`updateMedia`) · `uploadQueue.ts:273` |
| **Status** | Live. |

**Root cause** — the update path was implemented as a *media* PATCH only (`PATCH /upload/drive/v3/files/{id}?uploadType=media`), not a metadata PATCH. Tauri/Drive keep the original `name` and `modifiedTime`.

**Ripple effects** — an invoice updated in place keeps its **stale filename** forever. Combined with C-01 this is doubly bad: the key changes on rename (new file) *and* the surviving file's name is wrong. Users browsing the Drive folder see misleading names and cannot tell which file is current.

**Remediation reference:** Stage 2, Task 2.4.

---

#### **C-05 — `tenantId` in the upsert key is the literal string `"archive"`**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/uploadQueue.ts:82` |
| **Status** | Live. |

**Root cause** — the queue row does not carry the tenant id, so a constant placeholder was used. `appKey` (`packages/shared/src/archivePaths.ts:128-132`) joins the parts with `|`.

**Ripple effects** — two different installations (or two companies) sharing one Google account produce **identical `motardKey`s** for the same document id. A lookup may then find and **overwrite another company's file**. The file name is never changed (C-04), which hides the collision.

**Remediation reference:** Stage 2, Task 2.2.

---

#### **C-06 — The "found → updateMedia" upsert branch has zero test coverage**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/tests/drive-upload-queue.test.ts:56` · `drive-archive-pipeline.test.ts:70` · `drive-monthly-job.test.ts:108,143` · `drive-run-progress.test.ts:80` |
| **Status** | Live. |

**Exact location** — every fake returns `null`:
```ts
// drive-upload-queue.test.ts:55-59
// Phase 2 upsert: no file carries an app key in this fake, so every upload creates a new file.
async findByAppKey(_appKey: string, _parentId?: string) { return null; },
async updateMedia(fileId: string, _mime: string, _content: Uint8Array) {
  return { id: fileId, name: "updated", mimeType: "text/csv" };
},
```

**Root cause** — the fake was written to satisfy the *creation* path, and the plan explicitly noted the gap (`PLAN.md:232`: *"No test exercises an actual 'found → updateMedia' path against a Drive-like server"*) but then treated it as a known limitation rather than a blocking gap.

**Ripple effects** — the headline Phase 2 exit criterion (*"two uploads of the same invoice with different content produce one Drive file"*, `PLAN.md:290`) is **unverified**. The backend suite reports **79/79 green** across 8 Drive test files while the single most important behaviour of the feature is untested. Combined with C-01, the odds that a real-world rename produces a duplicate are effectively 1.0.

**Remediation reference:** Stage 2, Task 2.5 — **this is the single most valuable missing test in the change set.**

---

#### **C-07 — `passInFlight` is a module-level boolean with an `await` between check and set**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:134,149,151,156,272` |
| **Status** | Live. |

**Exact location**
```ts
// monthlyArchiveJob.ts:134
let passInFlight = false;
// :149
if (passInFlight) return { ...report, skipped: "BUSY" };
// :151  ← await between the check and the set
await authorizeUploadDevice(db, ...);
// :156
passInFlight = true;
```

**Root cause** — a classic **TOCTOU (time-of-check-to-time-of-use) race**. The guard is a non-atomic in-process flag, and the interval between the check and the set contains an `await`, during which the event loop can admit a second caller.

**Ripple effects** — three independent entry points can start a pass concurrently: the 6-hour timer (`monthlyArchiveJob.ts:302`), the `connect` trigger (`driveArchiveWiring.ts:70`), and the manual route (`drive.route.ts:146`, `:202`). Two concurrent passes can enqueue duplicate queue rows (mitigated by the `stableKey` hash dedupe) and interleave run-row updates, corrupting progress counters and the `motard_drive_runs` state machine. It is **per-process only** — there is no cross-process or DB-level guard on the *run*.

**Remediation reference:** Stage 2, Task 2.7.

---

#### **C-08 — The `skipped` reason is swallowed, making "busy" indistinguishable from "nothing to do"**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `backend/src/presentation/driveArchiveWiring.ts:58-61` |
| **Status** | Live. |

**Exact location**
```ts
// driveArchiveWiring.ts:58-61
syncNow: async () => { const r = await runArchivePass(deps, "manual"); return { queued: r.enqueued, started: r.processed > 0 }; },
```

**Root cause** — `runArchivePass` returns `skipped: "BUSY" | "NOT_COORDINATOR" | "NOT_CONNECTED" | undefined`, but the adapter drops it.

**Ripple effects** — the client receives `{ok:true, queued:0, started:false}` for every skip cause. The user cannot tell "another run is in progress" from "nothing to upload" from "this device is not the coordinator" from "Drive is not connected". Once a progress UI exists (Stage 3), this is actively misleading.

**Remediation reference:** Stage 2, Task 2.8.

---

#### **C-09 — No token refresh on HTTP 401**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts:132-179` (esp. `:137`, `:166`) |
| **Status** | Live. |

**Exact location**
```ts
// driveClient.ts:137 — the token is fetched ONCE, before the retry loop
// :166
if (res.status === 401) throw new DriveAuthError(...);
```

**Root cause** — the refresh-token minting chain lives in the Rust shell (`google.rs` → `boot.rs:319-360` → `POST /api/desktop/runtime/drive-token`). The backend's `DriveClient` treats the token as immutable for the life of the request and has no callback into the shell to re-mint it.

**Ripple effects** — a token that expires mid-pass (a 6-hour tick with a short-lived access token is likely) throws `DriveAuthError`, the queue marks the job **`blocked`** (`uploadQueue.ts:372-384`), and the archive **stops** until a human reconnects. This is the single most likely cause of "the archive silently stopped working" in the field.

**Remediation reference:** Stage 2, Task 2.10.

---

#### **C-10 — No request timeouts anywhere in the Drive client**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts:132-179` |
| **Status** | Live. |

**Root cause** — no `AbortSignal` / `AbortSignal.timeout()` is used anywhere in the file.

**Ripple effects** — a hung Google connection hangs the pass **indefinitely**. Because `passInFlight` stays `true` (C-07), every subsequent trigger returns `BUSY` — the archive is **permanently wedged** with no error, no log, and no timeout recovery.

**Remediation reference:** Stage 2, Task 2.11.

---

#### **C-11 — Resumable-upload session initialisation has no retry**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts:286-343` |
| **Status** | Live. |

**Root cause** — the session-init POST bypasses the shared `request()` retry helper; the PUT loop has its own retry but folds non-5xx errors into the retry path.

**Ripple effects** — a transient network blip during session init fails the upload of a large backup ZIP, which is then retried at the job level with backoff — acceptable, but the double-layer retry with mismatched policies can multiply attempts and duplicate resumable sessions.

**Remediation reference:** Stage 2, Task 2.12.

---

#### **C-12 — Post-upload verification is existence-only; `md5Checksum` is never compared**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/uploadQueue.ts:282-283` · `driveClient.ts` (`getFile` returns `md5Checksum`) |
| **Status** | Live. |

**Exact location**
```ts
// uploadQueue.ts:282-283
verified = await this.drive.getFile(meta.id);
if (!verified) throw new Error("post-upload verification failed: file id not found");
```

**Root cause** — the API returns `md5Checksum`; the code checks only that the file id resolves.

**Ripple effects** — a **truncated or corrupted upload is recorded as `done`**. The archive then claims success for a file that is not the file that was meant to be archived. Because the DB backup is the **only** path back from a catastrophic local loss, a silent corruption here is a data-loss risk.

**Remediation reference:** Stage 2, Task 2.13.

---

#### **C-13 — No download capability exists (`alt=media` absent repo-wide)**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical for Stage 4** |
| **Scope** | `backend/src/infrastructure/googledrive/driveClient.ts` (entire file) |
| **Status** | Live. |

**Exact location** — a repo-wide search for `alt=media` / `/download` returns **zero** hits in `driveClient.ts` (only an unrelated `POST /api/backups/:id/download` in the local backup route).

**Root cause** — the Drive client was built for the upload direction only; `G10` in the plan (`PLAN.md:24`) records this as a pre-existing fact.

**Ripple effects** — **there is currently no way to read a file back from Google Drive.** This is a hard prerequisite for the entire Smart Merge feature (Phase 5), for integrity verification (C-12), and for any "re-download and repair" workflow. Until this exists, the Drive archive is a **write-only sink** — which means the archive cannot currently be used to recover anything.

**Remediation reference:** Stage 2, Task 2.14 (must land **before** Stage 4).

---

### DOMAIN D — Scheduling & Run Lifecycle

---

#### **D-01 — The Rust archive scheduler is never started (100% dead code)**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/archive_scheduler.rs:91-103` · `main.rs:4` |
| **Status** | Live. Verified: `rg "archive_scheduler::" desktop-app/` → **no matches**. |

**Exact location**
```rust
// main.rs:4 — the ONLY reference in the repository
mod archive_scheduler;
```
```rust
// archive_scheduler.rs:91-103
pub fn start(today: …, ask: …, start_run: …) {
    std::thread::spawn(move || loop {
        let (last_done, in_flight) = ask();
        if let Decision::Start { period, catchup } = decide(today(), last_done, in_flight) {
            start_run(period, catchup);
        }
        std::thread::sleep(CHECK_EVERY);
    });
}
```

**Root cause** — the module was written (with 9 good unit tests for `decide()`), but the `main.rs` wiring was never written. The three closures (`today`, `ask`, `start_run`) have **no producer**: there is no HTTP plumbing from the shell to the backend at all.

**Ripple effects** — the compiler confirms it:
```
warning: function 'start' is never used
warning: 'Period', 'key', 'previous', 'days_in_month', 'Decision', 'decide', 'CHECK_EVERY' are never used
```
The entire month-end + catch-up design is dead in Rust. The backend's 6-hour worker (D-02) is the only thing actually running.

**Remediation reference:** Stage 2, Task 2.15 (decision: wire **or** delete — see D-03).

---

#### **D-02 — No monthly schedule exists; the backend re-exports 24 months every 6 hours**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:50-51, 167-187, 297-308` |
| **Status** | Live. The plan's own finding `G8` (`PLAN.md:22`) is unfixed. |

**Exact location**
```ts
// monthlyArchiveJob.ts:50-51
const CATCHUP_MONTHS = 24;           // don't walk history forever on a fresh install
const TICK_MS = 6 * 60 * 60 * 1000;   // 4×/day; catch-up makes the rest safe
// :167-187 — every tick, unconditionally, all 24 months
const months = recentMonthStarts(CATCHUP_MONTHS);
for (const start of months) {
  const periodKey = periodKeyOf(start);
  for (const f of await monthFiles(exporters, periodKey)) {
    const r = await queue.enqueue({ … });
```

**Root cause** — the header comment at `:7-8` and `:138-140` claims the job handles *"the month exports of uncovered months"*, but **there is no coverage filter**. There is also no durable "period already archived" marker to filter on — a direct consequence of B-02.

**Ripple effects**
1. Every 6-hour tick re-queries the DB and re-renders CSVs for **24 months** (≈72 queries + N CSV renders + N SHA-256 hashes), then **discards the result** because the `stableKey` dedupe suppresses re-upload.
2. `regenerate()` (`:119-132`) calls `monthFiles(exporters, job.periodKey)` **per claimed row** → the whole month is re-exported for **every single job** → **O(jobs × months)** work per pass.
3. On a large database this is sustained CPU and I/O burn on the user's desktop, 4× a day, forever.
4. **There is no monthly schedule at all** — the headline deliverable *"Automated Monthly Document Generation"* does not exist as a schedule.

**Remediation reference:** Stage 2, Task 2.16.

---

#### **D-03 — Two competing schedulers are designed; only one runs**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `desktop-app/src-tauri/src/archive_scheduler.rs:86` (30 min) · `monthlyArchiveJob.ts:51, 297-308` (6 h) |
| **Status** | Latent — masked by D-01. |

**Root cause** — the plan's D-5 ("the shell triggers the monthly job") and the backend's existing worker were never reconciled. The plan's Phase 4b even acknowledges the conflict (`PLAN.md:376-377`) but resolves it by keeping both.

**Ripple effects** — if D-01 is fixed by *wiring* the Rust scheduler without removing the backend's, both fire. The backend's `passInFlight` would serialise them, but the Rust loop's 30-minute cadence vs. the backend's 6-hour cadence means the backend's pass could run *during* the Rust-originated pass and be silently skipped — producing exactly the "monthly archive didn't happen" symptom the feature exists to prevent.

**Remediation reference:** Stage 2, Task 2.15 — **pick exactly one owner**; the recommendation is the backend (it owns the run table, the primary-device gate, and the queue).

---

#### **D-04 — Month-end archive fires at 00:xx on the last day, before that day's transactions exist**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/archive_scheduler.rs:69, 73` |
| **Status** | Live in the Rust design. |

**Exact location**
```rust
// archive_scheduler.rs:69
let is_month_end = d >= days_in_month(y, m);
// :73
let due = if is_month_end { current } else { current.previous() };
```

**Root cause** — the decision fires on the **calendar day**, not after the period is closed. The 30-minute tick means it fires at ~00:00–00:30 on the 31st.

**Ripple effects** — the archive for that month is taken **before the final day's invoices, vouchers, and cashbox movements are recorded**. The monthly archive is then permanently incomplete for that period (a later run would produce a *different* key set, but the plan has no "re-archive / supersede" mechanism).

**Remediation reference:** Stage 2, Task 2.17 — fire **after** the period closes (e.g. the 1st of the following month), not on the last day.

---

#### **D-05 — Catch-up is only one month deep**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/archive_scheduler.rs:73` · module doc `:5-7` |
| **Status** | Live in the Rust design. |

**Exact location**
```rust
// :73
let due = if is_month_end { current } else { current.previous() };
```
The module doc claims: *"it fires on boot / any later check when an earlier month never completed"* — but the code only ever considers **the single immediately-previous month**.

**Ripple effects** — a desktop that was off for three months archives only the immediately-previous month. After that run completes, `done >= due` → `Wait("ALREADY_DONE")` **forever**. The two older months are never archived and the system believes it is up to date. **Silent, permanent archive gap.**

**Remediation reference:** Stage 2, Task 2.18 — walk back **all** uncovered periods, not one.

---

#### **D-06 — `POST /drive/archive/runs` ignores its request body**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/presentation/routes/drive.route.ts:202-211` |
| **Status** | Live. |

**Exact location**
```ts
router.post("/drive/archive/runs", adminGuard, async (_req, res) => {
```

**Root cause** — the plan specifies `{trigger, periodKey}` (`PLAN.md:381`) but the handler discards the body. The Rust scheduler's `Decision::Start { period, catchup }` therefore has **no way to express itself** to the backend.

**Ripple effects** — `deps.syncNow` → `runArchivePass(deps, "manual")` → the run's trigger is always `"manual"` and the run row's `kind` is hard-coded `"catchup"` (`monthlyArchiveJob.ts:159`). The period is always `periodKeyOf(new Date())` (`:163`). The scheduler cannot request a specific period, and the run history cannot distinguish trigger types.

**Remediation reference:** Stage 2, Task 2.19.

---

#### **D-07 — The run route `await`s the entire archive pass before answering `202`**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/presentation/routes/drive.route.ts:202-211` · `monthlyArchiveJob.ts:200` |
| **Status** | Live. |

**Root cause** — `202 Accepted` semantics require responding immediately with a handle; the handler instead performs the full synchronous pass (up to 25 uploads, each potentially with backoff) and *then* answers.

**Ripple effects** — the HTTP request can block for **minutes**. Any client timeout kills the request while the pass continues server-side, leaving the client with no handle and no way to observe or cancel the run. This alone makes the progress feature unimplementable as designed.

**Remediation reference:** Stage 2, Task 2.20.

---

#### **D-08 — No `runId` is returned, making the progress route unreachable**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/presentation/routes/drive.route.ts:202-211` (response) vs. `:214-228` (progress route) |
| **Status** | Live. |

**Root cause** — the response body is `{ok, queued, started}`; the progress route is keyed by `run.id`. The two were never connected.

**Ripple effects** — `GET /drive/archive/runs/:id` **cannot be driven by any client**. The plan's 1-second polling UI (`PLAN.md:97`, `:389`) is unimplementable.

**Remediation reference:** Stage 2, Task 2.20.

---

#### **D-09 — Run progress lives only in an in-memory map**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/googledrive/archiveRuns.ts:82-119` (`MAX_KEPT = 20`) |
| **Status** | Live. |

**Root cause** — the run's live progress is an in-process `Map`, while the durable row only carries the final state in a JSON blob (B-02).

**Ripple effects** — after any backend restart, `GET /drive/archive/runs/:id` **404s** even though the durable row exists. The `MAX_KEPT = 20` cap also evicts older runs. A user whose app restarted mid-archive loses all visibility into that archive.

**Remediation reference:** Stage 2, Task 2.21 (resolve together with B-02's migration).

---

#### **D-10 — `kind` hard-coded to `"catchup"`; `period_key` never populated**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:157-160` |
| **Status** | Live. |

**Exact location**
```ts
await db.insert(motardDriveRuns).values({ id: run.id, kind: "catchup", state: "running", startedAt: nowIso() });
```
The `kind` CHECK allows `'documents' | 'month_close' | 'db_backup' | 'catchup'` — but the run is a *monthly archive pass*, so `'catchup'` is semantically wrong for every run except a genuine catch-up.

**Ripple effects** — the run history cannot answer "was this month's archive monthly or catch-up?", which is exactly the query D-02/D-05 need.

**Remediation reference:** Stage 2, Task 2.22.

---

#### **D-11 — `scheduledRunEntry` is declared `= null` and never assigned**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `backend/src/presentation/driveArchiveWiring.ts:29` |
| **Status** | Live. One match in the entire repository. |

**Exact location**
```ts
export let scheduledRunEntry: ((trigger: "monthly" | "catchup") => Promise<unknown>) | null = null;
```

**Root cause** — a designed seam for the plan's "runtime route" (§4.2) that was never connected to an implementation.

**Ripple effects** — this is the **physical manifestation of the architectural hole** described in E-14: the backend has no channel by which to *ask* the shell to render. The seam exists; nothing fills it.

**Remediation reference:** Stage 3, Task 3.9.

---

#### **D-12 — The cancel flag is silently clobbered: cancelling a run never stopped it**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `backend/src/infrastructure/googledrive/archiveRuns.ts:90-93` · `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts` (7 `updateLiveRun` call sites) |
| **Status** | **Found during Stage 1 implementation.** Fixed in Stage 1. |

**Exact location**
```ts
// archiveRuns.ts — BEFORE the Stage 1 fix
export function updateLiveRun(runId: string, progress: RunProgress): void {
  const cur = live.get(runId);
  if (cur) live.set(runId, { ...cur, progress, updatedAt: Date.now() });   // ← overwrites the WHOLE progress
}
```
```ts
// monthlyArchiveJob.ts — the worker loop (BEFORE the Stage 1 fix)
for (let i = 0; i < 25; i++) {
  if (getLiveRun(run.id)?.progress.cancelRequested) break;   // reads the LIVE map
  …
  progress = advance(progress, fileName);   // the worker's LOCAL copy — cancelRequested is still false
  updateLiveRun(run.id, progress);          // ← writes the stale local copy back over the live map
}
```

**Root cause**
The cancel arrives **out of band**: `cancelLiveRun` touches only the in-memory live map. The worker keeps its **own** local copy of the progress, which knows nothing about that cancel. Every `updateLiveRun` wrote the local copy back wholesale, so `cancelRequested` was reset to `false` the moment the next file finished. The flag was therefore **never observed** — the loop's cancellation check could only ever see `false`.

**Ripple effects & cascading risks**
1. **The cancel feature did not work at all.** A cancelled run carried on uploading every remaining file and ended as `done`.
2. It was invisible: no error, no warning. The cancel route returned `200 {ok:true}` while the run carried on — the UI reported a cancellation that never happened.
3. It was masked by B-01: the CHECK violation rewrote the run's final state to `failed` anyway, so nobody could tell the cancel was ignored.
4. Even with B-01 fixed, a naive fix (relaxing the CHECK alone) would have left the cancel broken. **The two defects were stacked** — fixing only the CHECK would have turned a silent 500 into a silent no-op.

**The Stage 1 fix** — the cancel flag is made **monotonic**, and the worker's local copy is kept in step with the live one:
```ts
export function updateLiveRun(runId: string, progress: RunProgress): RunProgress {
  const cur = live.get(runId);
  const merged: RunProgress = cur
    ? { ...progress, cancelRequested: cur.progress.cancelRequested || progress.cancelRequested }
    : progress;
  if (cur) live.set(runId, { ...cur, progress: merged, updatedAt: Date.now() });
  return merged;   // the worker assigns it back: progress = updateLiveRun(run.id, progress)
}
```

**Regression test:** `backend/tests/drive-run-cancel.test.ts` — *"is stored as 'cancelled', not 'failed', and the pass does not throw"*. It holds the scripted upload open, cancels mid-flight, and asserts the run row reads `cancelled`.

**Remediation reference:** Stage 1, Task 1.2 (completed).

---

### DOMAIN E — PDF / PNG Rendering Engine

---

#### **E-01 — `webview2_render` returns `Err` for both output formats: no PDF or PNG is ever produced**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:188-210` (esp. `:204-208`) |
| **Status** | Live. The single blocking defect of deliverable 2. |

**Exact location**
```rust
fn webview2_render(platform: &PlatformWebview, html: &str, output: &Output) -> Result<Vec<u8>, String> {
    use webview2_com::pwstr_from_str;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    let controller = platform.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }.map_err(|e| format!("WebView2: {e}"))?;
    let html_w = pwstr_from_str(html);
    unsafe { core.NavigateToString(html_w) }.map_err(|e| format!("تحميل المستند: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(400));
    match output {
        Output::Pdf(_) => Err("PrintToPdf: الربط الكامل يتم في مرحلة التحقق على جهاز سطح المكتب".into()),
        Output::Png => Err("CapturePreview: الربط الكامل يتم في مرحلة التحقق على جهاز سطح المكتب".into()),
    }
}
```

**Root cause** — a deliberate, honest placeholder: only `CoreWebView2()` and `NavigateToString()` are called; the two output arms are hard-coded errors. A repo-wide search confirms **no** `PrintToPdf(` or `CapturePreview(` call, no `ICoreWebView2_7` cast, no `PrintSettings`, no `IStream` anywhere in `desktop-app/`.

**Ripple effects**
1. **Deliverable 2 produces no documents.** The archive to Drive is still **CSV only** (`exporters.ts` → `mimeType: "text/csv;charset=utf-8"`); `SECTION_LIST`/`sectionLabel` promise all six categories although only three are ever produced (`monthlyArchiveJob.ts:92-101`: sale invoices, entry invoices, expenses/cashbox — **no returns, no statements, no per-invoice PDF**).
2. The stub is **honest** (an error, not a fake empty file) — which is good practice and is credited. The problem is that the *surrounding documentation* claims otherwise (E-02).
3. Everything downstream of the renderer (the render-request channel, the progress UI, the per-document bundle) is unreachable.

**Remediation reference:** Stage 3, Task 3.1–3.7.

---

#### **E-02 — The module documentation is factually false**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:1-12` (esp. `:5-6`, `:8`, `:156-157`) |
| **Status** | Live. |

**Exact location**
```rust
//!   - `PrintToPdf` writes a paginated A4 / A5 PDF (`archive_render_pdf`);
//!   - `CapturePreview` writes a PNG of the page (`archive_capture_png`).
//!   - The caller (the backend, via the runtime route) re-hashes the staged file before it is uploaded.
```
```rust
// :156-157
/// Render `html` to a PDF on a hidden window and stage it.
/// ... waits for the load to finish, then asks the controller for the PDF or PNG bytes
```
**Every claim in these lines is false**: neither method is called; the command names are `archive_render_pdf_cmd` / `archive_capture_png_cmd`; the runtime route does not exist (`desktopRuntime.route.ts` registers only `pre-update-backup`, `drive-token`, `shutdown`); and there is no "wait for the load to finish" — there is a 400 ms sleep.

**Ripple effects** — a future maintainer (or auditor) reading the module doc will believe the feature works. This is precisely the class of drift that the audit was commissioned to detect, and it lives in the *newest* code. The plan document itself repeats the error (`PLAN.md:306` is accurate; the *code* is not).

**Remediation reference:** Stage 1, Task 1.5 (documentation honesty fix — cheap, and it prevents a repeat of the audit's core complaint).

---

#### **E-03 — `Paper::inches()` is dead code; the paper size is never applied**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:40-45, 152` |
| **Status** | Live. `cargo check` warns `method 'inches' is never used`. |

**Exact location**
```rust
// :40-45
pub fn inches(&self) -> (f64, f64) { … }
// :152
Output::Pdf(#[allow(dead_code)] Paper),
```
The `Paper` value is carried into `Output::Pdf(_)` and then **dropped on the `_` arm**.

**Root cause** — `PrintToPdf` requires page dimensions in **inches**, which is exactly what `inches()` was written for; the call that would consume it was never written.

**Ripple effects** — when the renderer is completed, the paper size must be threaded into `ICoreWebView2PrintSettings`. If `Paper` stays dead, every PDF silently defaults to letter/A4-default and the `@page` rule in `print.css:34` is ignored.

**Remediation reference:** Stage 3, Task 3.5.

---

#### **E-04 — A fixed 400 ms sleep replaces real readiness signals**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:202` |
| **Status** | Live. |

**Root cause** — no `NavigationCompleted` event subscription and no `document.fonts.ready` await. The Arabic font CSS (`ARCHIVE_ARABIC_FONT_CSS`, `printPortal.ts:240`) is inlined, but font *loading* and layout are not awaited.

**Ripple effects** — on a slow machine or cold font cache, the PDF is captured **before** the Arabic glyphs have shaped → a PDF with tofu boxes, mis-measured line breaks, or wrong page count. It is **timing-dependent**, so it will pass on the developer's machine and fail on a customer's.

**Remediation reference:** Stage 3, Task 3.4.

---

#### **E-05 — The commands are synchronous, so the render would block the UI thread**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `desktop-app/src-tauri/src/commands.rs:261, 275` · `pdf_render.rs:202` |
| **Status** | Latent — masked by E-01, but the shape is already wrong. |

**Root cause** — Tauri v2 runs **sync** `#[tauri::command]`s inline on the IPC thread, and the IPC message is handled on the main/event-loop thread. `std::thread::sleep(400ms)` therefore executes **on the UI thread**.

**Ripple effects** — today the app freezes 400 ms per render attempt. Once `PrintToPdf` is really wired, the freeze becomes the **entire render duration** (seconds per document, ×N documents in a monthly batch) — the desktop app becomes unusable during an archive. `with_webview` from a non-main thread also posts to the event loop, so the `recv_timeout(60s)` bound (`:179-181`) becomes the only guard.

**Remediation reference:** Stage 3, Task 3.6.

---

#### **E-06 — `PrintToPdf` requires `ICoreWebView2_7`, a `PrintSettings` object, and an async completion handler**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** *(design constraint for Stage 3)* |
| **Scope** | `webview2-com-sys-0.39.1/src/bindings.rs:43636-43657` · `pdf_render.rs:188-210` |
| **Status** | Not yet implemented. |

**Exact API shape (verified against the vendored crate)**
```rust
impl ICoreWebView2_7 {
    pub unsafe fn PrintToPdf<P0,P1,P2>(&self, resultfilepath: P0, printsettings: P1, handler: P2)
    //   P0: Param<PCWSTR>
    //   P1: Param<ICoreWebView2PrintSettings>
    //   P2: Param<ICoreWebView2PrintToPdfCompletedHandler>
}
```

**Root cause / impact** — `PrintToPdf` lives on **`ICoreWebView2_7`**, not `ICoreWebView2`. A real implementation must `core.cast::<ICoreWebView2_7>()`, construct an `ICoreWebView2PrintSettings` (page size in **inches** — see E-03), and **handle the asynchronous completion callback**. The current synchronous `-> Vec<u8>` signature **cannot be completed without redesign**; it needs a channel/oneshot bridged from the completion handler.

**Remediation reference:** Stage 3, Task 3.3.

---

#### **E-07 — `CapturePreview` requires an `IStream` and an async completion handler**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** *(design constraint for Stage 3)* |
| **Scope** | `webview2-com-sys-0.39.1/src/bindings.rs:1376-1395` · `pdf_render.rs:207` |
| **Status** | Not yet implemented. |

**Exact API shape**
```rust
impl ICoreWebView2 {
    pub unsafe fn CapturePreview<P1,P2>(&self, imageformat: …, imagestream: P1, handler: P2)
    //   P1: Param<IStream>
    //   P2: Param<ICoreWebView2CapturePreviewCompletedHandler>
}
```

**Remediation reference:** Stage 3, Task 3.3.

---

#### **E-08 — `pwstr_from_str` allocation is never freed**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** |
| **Scope** | `desktop-app/src-tauri/src/pdf_render.rs:200` · `webview2-com-0.39.1/src/pwstr.rs:141` |
| **Status** | Live. |

**Root cause** — `pwstr_from_str` allocates with `CoTaskMemAlloc`; the returned `PWSTR` is dropped without `CoTaskMemPWSTR::take_pwstr()`, leaking the buffer.

**Ripple effects** — one small leak per render. Bounded (monthly batch), but it is a correctness issue in a COM-heavy path and will be flagged by any memory audit.

**Remediation reference:** Stage 3, Task 3.7.

---

#### **E-09 — `pdf_render.rs` is not `#[cfg(windows)]`-gated while its dependency is Windows-only**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** |
| **Scope** | `desktop-app/src-tauri/Cargo.toml:32-44` · `pdf_render.rs` (module-level) |
| **Status** | Live. |

**Root cause** — `webview2-com` is declared under `[target.'cfg(windows)'.dependencies]`, but `main.rs` declares `mod pdf_render;` unconditionally.

**Ripple effects** — the crate would not compile on macOS/Linux. The project is effectively Windows-only today (`main.rs:2` `windows_subsystem`; `commands.rs:107-127` uses `windows::Win32::System::Registry` unconditionally), so this is not an active break — but it is an unguarded platform assumption that will surface if cross-platform is ever attempted.

**Remediation reference:** Stage 3, Task 3.10.

---

#### **E-10 — Two versions of the `windows` crate coexist in the dependency tree**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** |
| **Scope** | `desktop-app/src-tauri/Cargo.toml:33-44` · `Cargo.lock` |
| **Status** | Live. |

**Exact state** — `webview2-com = "=0.39.1"` is pinned **correctly** (it matches what tauri already links; `Cargo.lock` contains exactly **one** copy of `webview2-com 0.39.1` and one of `webview2-com-sys 0.39.1` — the "one copy, not two" claim in `Cargo.toml:41-43` is accurate). The side effect is that `windows` appears as **both 0.61.2** (direct dep) and **0.62.2** (pulled by `webview2-com`).

**Remediation reference:** Stage 3, Task 3.10 (align to 0.62 to dedupe).

---

#### **E-11 — No frontend caller exists for any of the three bridge functions**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `src/infrastructure/tauri-bridge.ts:198-234` |
| **Status** | Live. |

**Exact location**
```ts
// tauri-bridge.ts:198
export async function archiveRenderPdf(opts: { runId: string; html: string; outName: string; paper: "A4" | "A5" }): Promise<StagedRender | null>
```
```ts
// tauri-bridge.ts:215
export async function archiveCapturePng(opts: { runId: string; html: string; outName: string; width: number }): Promise<StagedRender | null>
```
```ts
// tauri-bridge.ts:230
export async function archiveClearRun(opts: { runId: string }): Promise<boolean>
```

**Root cause** — the bridge layer was written ahead of any consumer.

**Ripple effects** — a repo-wide grep finds these names **only in `tauri-bridge.ts` itself**. Even after E-01 and A-01/A-02 are fixed, the functions remain unreachable. **No test covers them.** The entire frontend half of deliverable 2 is unwired.

**Remediation reference:** Stage 3, Task 3.11.

---

#### **E-12 — The snapshot route and the renderer disagree on the contract (HTML string vs. URL)**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `src/routes/archive-snapshot.tsx:67-78` · `desktop-app/src-tauri/src/commands.rs:275-283` · `pdf_render.rs:199-200` |
| **Status** | Live. |

**Exact location**
```tsx
// archive-snapshot.tsx:67-78 — renders a FRAGMENT, not a full document
return (
  <div data-archive-ready="true" data-archive-period={period} style={{ width: SNAPSHOT_WIDTH_PX, background: "#fff", padding: 24, direction: "rtl" }}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
  </div>
);
```
```rust
// commands.rs:275-283 — takes an HTML STRING
pub fn archive_capture_png_cmd(app: AppHandle, sh: Sh<'_>, run_id: String, html: String, out_name: String) -> …
// pdf_render.rs:199-200 — NavigateToString, never navigates to a URL
unsafe { core.NavigateToString(html_w) }
```

**Root cause** — the plan (§3d, `PLAN.md:344`) specified *"The renderer loads `…/archive-snapshot?period=YYYY-MM&currency=SYP` in the hidden WebView"*. The implementation changed the contract to pass an HTML string but **never updated the route** to produce a full document, and never connected the route to the renderer.

**Ripple effects**
- The route is **mounted** (`routeTree.gen.ts:13`, `:68-72`, `:1069`) and reachable by URL via the SPA fallback (`backend/src/presentation/staticApp.ts:57`) — so it looks live, but **nothing references it**.
- `wrapArchiveDocument` (the function that produces a self-contained `<html>/<head>/<style>`) is **never called by the route** — only by tests.
- The route also exposes the B-04 `cashOut` bug in a route that is one wiring step away from shipping.

**Remediation reference:** Stage 3, Task 3.2 (decide the contract) + Task 3.12.

---

#### **E-13 — Five of six document builders are test-only**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `src/components/print/archiveDocuments.ts` |
| **Status** | Live. |

**Exact location** — the module exports `escapeHtml` (:16), `wrapArchiveDocument` (:31), `fmtMoney` (:64), `fmtKg` (:70), `buildInvoiceBody` (:114), `orderStatementLegs` (:194), `runningBalances` (:208), `buildStatementBody` (:221), `buildCashboxBody` (:295).

Only **`buildCashboxBody`** has a production importer (`archive-snapshot.tsx:13`). `buildInvoiceBody`, `buildStatementBody`, `wrapArchiveDocument`, `orderStatementLegs`, `runningBalances`, `fmtKg` are exercised **only** by `src/components/print/__tests__/archiveDocuments.test.ts`.

**Root cause** — the builders were developed TDD-first against golden assertions, which is good practice; the production consumers were never written.

**Ripple effects** — ~19 high-quality tests give the *appearance* of a working document pipeline. The quality of the pure layer is real and is credited; but the layer is disconnected.

**Remediation reference:** Stage 3, Task 3.13.

---

#### **E-14 — Architectural hole: no channel exists for the backend to request a render**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical (architectural)** |
| **Scope** | `backend/src/presentation/routes/desktopRuntime.route.ts:32,60,84` · `driveArchiveWiring.ts:29` · `backend/src/infrastructure/googledrive/archiveBundle.ts` (entire file) · `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md` §3e, §4.2 |
| **Status** | Live. |

**Exact location — the runtime routes that actually exist**
```ts
// desktopRuntime.route.ts
router.post("/api/desktop/runtime/pre-update-backup", …)   // :32
router.post("/api/desktop/runtime/drive-token", …)         // :60
router.post("/api/desktop/runtime/shutdown", …)            // :84
```
`POST /api/desktop/runtime/archive-artifact` — the plan's *response* path (`PLAN.md:386`) — **does not exist**.

**Root cause** — the plan describes a bidirectional handshake but only specifies one direction:
- **Response path** (planned): shell → backend, delivering a rendered file (`PLAN.md:386`).
- **Request path** (never planned, never built): backend → shell, asking *"render this document"*.

`archiveBundle.ts` is a **pure** module — no DB import, no Drive import, no query. Its `decideRender` (`:42-50`) has **zero production callers** (only `backend/tests/drive-archive-bundle.test.ts`). `tally` (`:55-64`), `canonicalJson` (`:15`), `sourceHash` (`:30`) are likewise test-only.

**Ripple effects**
1. The backend **cannot** tell the shell what to render; the shell **cannot** ask the backend for anything but a token. The two processes have no render handshake.
2. `scheduledRunEntry` (D-11) is the abandoned seam for exactly this.
3. `PLAN.md:386` cites a route that does not exist — the plan **documents a fiction**.
4. Consequently, deliverable 2's architecture cannot work as written in either direction.

**Remediation reference:** Stage 3, Task 3.9 — design and build the request channel *before* building the renderer, because it determines the renderer's contract.

---

### DOMAIN F — Local Archive & Functional Regression

---

#### **F-01 — `print_send` / `print_receive` archiving is broken (regression introduced by this change set)**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical (functional regression)** |
| **Scope** | `desktop-app/src-tauri/src/commands.rs:145-154, 247` · `src/infrastructure/tauri-bridge.ts:129` · `src/routes/invoices.print-send.new.tsx:268` · `src/routes/invoices.print-receive.new.tsx:309` |
| **Status** | **Live regression.** |

**Exact location**
```rust
// commands.rs:145-154 — the two doc types were DROPPED from the mapping
fn category_for_doc_type(doc_type: &str) -> Option<&'static str> {
    match doc_type {
        "entry" => Some("entry_invoices"),
        "sale" => Some("sale_invoices"),
        "return_sale" | "return_entry" => Some("returns"),
        "statement" => Some("statements"),
        "cashbox" => Some("cashbox"),
        _ => None,
    }
}
// :247
let category = category_for_doc_type(&doc_type).ok_or("نوع مستند غير معروف")?;
```
```ts
// tauri-bridge.ts:129 — the frontend STILL declares them
export type ArchiveDocType = "sale" | "entry" | "print_send" | "print_receive" | "statement";
```

**Root cause** — the Rust category mapping was rewritten during the Phase 2 category-set change, and the two print document types were **silently dropped**. The old `DOC_FOLDERS` constant had folders for them; the new `category_for_doc_type` does not. The frontend type was never updated to match, so the type system cannot catch the divergence.

**Ripple effects**
1. `printPortal.archiveIfDesktop` → `archiveDocumentPdf` → the Rust command returns `Err("نوع مستند غير معروف")` → the catch shows `تعذّر حفظ PDF: …` (`printPortal.ts:244`) and **no file is archived**.
2. **Two document types are silently unarchivable** — print-send and print-receive vouchers are exactly the documents that move stock, so their absence creates a hole in the archive record.
3. The Rust test only asserts that `"payroll"` is refused (`commands.rs:455`) — **there is no assertion that every frontend-emittable `ArchiveDocType` maps to a category**. The gap is structurally invisible to the test suite.

**Remediation reference:** Stage 1, Task 1.7 — restore the mapping **and** add the exhaustive parity test.

---

#### **F-02 — `ensureDocumentFolders` is called without the `period`**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `src/components/print/printPortal.ts:224` · `src/infrastructure/tauri-bridge.ts:142-149` · `desktop-app/src-tauri/src/commands.rs:225-236` |
| **Status** | Live. |

**Exact location**
```ts
// printPortal.ts:224
await ensureDocumentFolders(companyName);
```
while the Rust signature gained a `period` parameter and the same call site correctly threads the business month into the *file* path (`printPortal.ts:226-232` passes `meta.period`).

**Root cause** — the signature was extended but one call site was not updated.

**Ripple effects** — the six category folders are pre-created for the **current** month, while the document is filed under its **business** month. The file still lands correctly (`commands.rs:250` `create_dir_all`), but the sibling category folders for that business month are never created, so the Drive/local tree is incomplete for historical months.

**Remediation reference:** Stage 2, Task 2.23.

---

#### **F-03 — The local archive root folder name diverges from the shared/Drive layout**

| Field | Value |
|---|---|
| **Severity** | **S3 — Medium** |
| **Scope** | `desktop-app/src-tauri/src/commands.rs:174-177` · `packages/shared/src/archivePaths.ts:57-61` |
| **Status** | Live. |

**Exact location**
```rust
// commands.rs:174-177 — LOCAL root: Desktop\<company>\   (no " - أرشيف النظام" suffix)
fn archive_root(app: &AppHandle, company: Option<&str>) -> Result<PathBuf, String> {
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    Ok(desktop.join(safe_name(company.unwrap_or(""), "Motard ERP")))
}
```
```ts
// archivePaths.ts:57-61 — SHARED/Drive root: <company> - أرشيف النظام
export function companyFolderName(companyName: string | null | undefined): string { … }
```

**Root cause** — the "one naming engine" (§1.4, `PLAN.md:130`) was adopted for Drive (`folderOrganizer.ts:39` calls `companyFolderName`) but **not** for the Rust local archive, which uses its own `safe_name` helper.

**Ripple effects** — the plan's central claim that *"Local archive and Drive archive share one naming engine"* is **false today**. Users see two differently-named trees for the same archive, and any tooling that assumes one layout will mis-target one of them.

**Remediation reference:** Stage 2, Task 2.24.

---

#### **F-04 — The category parity test is one-directional and string-based**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** |
| **Scope** | `desktop-app/src-tauri/src/commands.rs:438-447` |
| **Status** | Live. |

**Exact location**
```rust
#[test]
fn desktop_categories_match_the_shared_archive_categories() {
    let ts = include_str!("../../../packages/shared/src/archivePaths.ts");
    let start = ts.find("export const ARCHIVE_CATEGORIES").expect("shared categories present");
    let block = &ts[start..ts[start..].find("} as const").map(|i| start + i).expect("block end")];
    for (_, label) in super::ARCHIVE_CATEGORIES {
        assert!(block.contains(label), "shared categories lack {label}");
    }
    assert_eq!(super::ARCHIVE_CATEGORIES.len(), 6);
}
```

**Root cause** — the assertion is `Rust ⊆ TS` on the **label strings only**. It does **not** verify the **keys**, does **not** verify the reverse direction (`TS ⊆ Rust`), and does not detect a duplicated label.

**Ripple effects** — a shared-module rename of a category **key** (with the label unchanged) passes the test while the two implementations diverge. This is the same class of gap that let F-01 through.

**Remediation reference:** Stage 1, Task 1.8 (strengthen alongside the F-01 parity test).

---

### DOMAIN G — Smart Merge / Reconciliation Engine (Design Flaws — Stage 4)

> **All of Domain G is currently a design-only defect**: no merge code exists, so nothing is currently corrupted. These are defects in the *specification* that would cause corruption if implemented literally. They are listed in full because Stage 4 is a re-architecture, not a build.

---

#### **G-01 — The Smart Merge engine is entirely unimplemented**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `backend/src/infrastructure/backup/` (no merge directory) · `backend/src/presentation/routes/` (no merge routes) · `src/components/drive/` (no merge UI) |
| **Status** | **0% implemented.** |

**Exact location** — a repo-wide search for every identifier Phase 5 introduces returns **exactly one file**, the plan document:
```
rg "merge-plan|merge-apply|motard_merge|motard_backup_catalog|downloadToFile|alt=media"
→ .\docs\GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md     (only hit)
```
Missing: `mergePlanner.ts`, `mergeApply.ts`, `replay.ts`, `mergeStage.ts`, `driveDownload.ts`, `motard_merge_runs`, `motard_merge_plans`, `motard_backup_catalog`, `BackupHistoryTable.tsx`, `MergeRestoreDialog.tsx`, `src/lib/drive-backups.ts`, `GET /api/drive/backups`, `POST /api/drive/backups/:id/merge-plan`, `POST /api/drive/backups/:id/merge-apply`.

**Ripple effects** — deliverable 3 is **absent**. The audit's 45/100 score is dominated by this.

**Remediation reference:** Stage 4, Task 4.1 (design-first: the plan's §5 must be rewritten before code).

---

#### **G-02 — The cashbox replay double-counts against a trigger-maintained cumulative series**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | Plan §5g (`PLAN.md:480`) vs. `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql:1689-1711` (SQLite) and `backend/src/infrastructure/orm/migrations/20260928_cashbox_daily_balances.sql:28-73,150-196` (PG) |
| **Status** | Design defect. Would corrupt data on implementation. |

**Exact location — the trigger**
```sql
-- 0000_baseline.sql:1689-1711
CREATE TRIGGER "cashbox_daily_ledger_ai" AFTER INSERT ON "ledger_entries"
WHEN COALESCE(NEW."status", 'active') = 'active' AND NEW."cash_impact" IN ('in','out')
...
ON CONFLICT ("tenant_id", "currency", "balance_date") DO UPDATE SET
  "closing_balance" = "closing_balance" + (...);
UPDATE "cashbox_daily_balances"
   SET "closing_balance" = "closing_balance" + (...)
 WHERE "tenant_id" = NEW."tenant_id" AND "currency" = NEW."currency" AND "balance_date" > NEW."date";
```

**Root cause**
`cashbox_daily_balances.closing_balance` is **not** an independent per-day value — it is a **running cumulative total** maintained incrementally by DB triggers. Inserting an old-dated ledger row therefore (i) adds the delta to that day **and (ii) shifts every later day's closing balance**. The plan §5g then proposes to *also* replay `closing_balance` *"carrying forward from the first merged date"* — **applying the delta a second time**.

**Ripple effects**
1. Every day after the merge point carries the imported amount **twice**.
2. The error is **silent** — no constraint, no exception.
3. It is **not self-healing**: `getCashboxBalanceAsOf` (`cashboxBalanceHelper.ts:117-140`) prefers the cached row and only falls back to `recomputeCashboxBalanceAsOf` when no row exists — so the corrupted cache **wins over the correct recompute**.
4. The user's cash position for the whole post-merge period is wrong — the single most user-visible financial number in the product.

**The correct algorithm already exists in the codebase** and the plan misses it:
```ts
// backend/src/infrastructure/repositories/sqlite/helpers/dyePurgeRepository.ts:390-445
/**
 * Rebuild the per-day drawer series for the given currencies from the movements that survive.
 * The whole series is rebuilt rather than a suffix because `closing_balance` is cumulative:
 * a windowed sum from the first movement is the only value that cannot drift
 * from `ledger_entries` + `manual_movements`.
 */
```
`rebuildCashboxSeries` = `DELETE` the series, then `INSERT … sum(daily_delta) OVER (PARTITION BY currency ORDER BY day)`.

**Remediation reference:** Stage 4, Task 4.3 — use `rebuildCashboxSeries` **verbatim**, and neutralise the trigger for the merge transaction (mirroring the existing `allow_dye_purge` flag pattern in `motard_tx_state`).

---

#### **G-03 — The ledger has no natural key → silent double-posting**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql:1544` · `ledger-entry.table.ts` · plan §5f (`PLAN.md:464`) |
| **Status** | Design defect. |

**Exact location**
```sql
-- 0000_baseline.sql:1544 — the ONLY dedup key on the ledger
CREATE UNIQUE INDEX "uq_ledger_entries_tenant_client_op"
  ON "ledger_entries" ("tenant_id","client_operation_id") WHERE client_operation_id IS NOT NULL;
```
The append-only trigger fires `BEFORE UPDATE OR DELETE` only — **INSERT is unrestricted**:
```ts
// SqliteLedgerRepository.ts:141-165 — writeMany has NO guard of any kind
async writeMany(entries: WriteLedgerEntry[], ctx: TenantContext): Promise<LedgerEntryData[]> {
  const rows = await this.db.insert(ledgerEntries).values(entries.map((e) => ({ … date: e.date, … })));
```

**Root cause** — the ledger is a pure event register with no business identity column. Rows created by the app may carry `client_operation_id = NULL`, in which case even the partial unique index provides no protection.

**Ripple effects**
> A merge that re-inserts the same historical ledger legs **doubles the money with no DB error, no constraint violation, and no warning.** The imported region's party balances become exactly 2×.

The plan's invariant set does **not** detect this: I-1 compares the ledger sum to the *replayed* balance (both wrong together), and I-2 checks invoice totals against lines (a different axis entirely).

**Remediation reference:** Stage 4, Task 4.4 — add a deterministic identity column + unique index (**business-table change ⇒ PG migration + PG twin per CLAUDE.md**), or refuse to merge any ledger-bearing period until identity exists.

---

#### **G-04 — `stock_movements` has neither an idempotency key nor a pieces column**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** (with G-05) |
| **Scope** | `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql:1102-1129` · `stock-movement.table.ts:5-37` |
| **Status** | Design defect. |

**Exact location** — `stock_movements` columns include `quantity_kg`, `direction`, `balance_after_kg` — but **no `client_operation_id`** (unlike `invoices`, `ledger_entries`, `returns`, `vouchers`, which all have partial-unique indexes on it) and **no pieces column**.

**Ripple effects** — stock movements are the most duplicate-prone rows in the schema (they have no uniqueness at all), and they are the *only* audit trail for roll quantity. A merge that re-inserts them doubles the quantity movement history while the counter is also updated → roll stock desynchronises silently.

**Remediation reference:** Stage 4, Task 4.5 — extend `stock_movements` with `client_operation_id` and `pieces_delta` (**PG migration + PG twin + SQLite baseline regeneration**), or exclude stock-bearing periods from merge.

---

#### **G-05 — `remaining_pieces` is unreconstructable**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | `roll.table.ts:31` · `0000_baseline.sql:988` · `0000_baseline.sql:1102-1129` (no pieces column) · plan §5g (`PLAN.md:478`) |
| **Status** | Design defect. |

**Exact location**
```ts
// roll.table.ts:31 — stored counter, app-maintained
remainingPieces: integer("remaining_pieces").notNull().default(0),
```
The only kg-level audit trail is `stock_movements` (with `balance_after_kg`). **There is no pieces-level audit trail anywhere.** The DB guard is only `CHECK (remaining_kg >= 0)` (`0000_baseline.sql:989`) — nothing checks pieces.

**Root cause** — `remaining_kg` was given an audit trail; `remaining_pieces` was not. The plan assumes both can be replayed.

**Ripple effects** — any merge that changes a roll's line set (a line replacement, a deletion) drifts `remaining_pieces` **permanently and silently**, with no trail to reconcile against and no constraint to trip. Note the plan's own table ordering makes this worse: `print_send` / `print_receive` / inventory-count movements have **no invoice parent**, so they are the hardest to reconstruct — and they are exactly the ones that carry pieces.

**Remediation reference:** Stage 4, Task 4.5 — extend `stock_movements` with `pieces_delta` first, or **refuse to merge any period containing pieces-affecting movements**.

---

#### **G-06 — Policy D-7 is unimplementable against a live UNIQUE constraint**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | Plan D-7 (`PLAN.md:157`) · `0000_baseline.sql:479, 944, 1460` |
| **Status** | Design defect. |

**Exact location**
```sql
-- 0000_baseline.sql:479
CONSTRAINT "invoices_tenant_id_type_number_key" UNIQUE ("tenant_id", "type", "number"),
-- :944
CONSTRAINT "returns_tenant_id_kind_number_key" UNIQUE ("tenant_id", "kind", "number"),
-- :1460
CONSTRAINT "vouchers_tenant_id_kind_number_key" UNIQUE ("tenant_id", "kind", "number"),
```
```md
<!-- PLAN.md:157 — D-7 -->
Recommended: match by UUID first; a same-number/different-UUID pair is imported under the
backup's UUID and flagged for renumbering review, never silently merged
```

**Root cause** — the policy is defined as a *display/flag* concern, but the DB rejects the insert outright. The plan flags the collision **after** the fact; the constraint fires **during** the transaction.

**Ripple effects** — the merge transaction aborts on the first colliding number, with no path forward. Resolving it requires renumbering — which mutates the backup's `number` and invalidates its ledger `reference_number` free-text values. The plan treats D-7 as a UI concern; it is a **data-migration problem**.

**Remediation reference:** Stage 4, Task 4.7 — detect collisions in the planner, **propose a new number, and rewrite the number + `reference_number` in the staged copy** before the apply step.

---

#### **G-07 — The closed-period freeze is application-level only, and the plan flags too late**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | `backend/src/infrastructure/repositories/sqlite/helpers/dayLockHelper.ts:26-46, 64-80` · `SqliteLedgerRepository.ts:141-165` · plan §5g (`PLAN.md:481`) |
| **Status** | Design defect. |

**Exact location**
```ts
// dayLockHelper.ts:26-46
export async function assertDayUnlocked(tx, tenantId, date, currency) {
  const [row] = await tx.select({ id: dayCloses.id })…
  if (row) throw new DayLockedError(`${date} (${currency})`);
  await assertYearOpen(tx, tenantId, date);
}
```

**Root cause** — there are **zero** DB triggers rejecting old-dated inserts. The freeze is entirely in application code, and `SqliteLedgerRepository.writeMany` — the natural bulk-insert API a merge engine would use — **has no guard at all**.

**Ripple effects** — the plan says *"day_closes are never recomputed: a merged date that already has a day close is flagged for review instead."* By the time such a flag could be raised, the ledger rows are **already inserted** and the cashbox trigger has **already shifted the entire later series**. The refusal must be a **pre-apply gate**, not a post-hoc note.

**Remediation reference:** Stage 4, Task 4.8 — pre-apply refusal, enforced in the planner and re-checked inside the transaction.

---

#### **G-08 — Invariant I-3 is already false on healthy production data**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | Plan §5h I-3 (`PLAN.md:488`) · `invoice.table.ts:40-45` · `SqliteInvoiceRepository.ts:401` |
| **Status** | Design defect. See also B-05. |

**Root cause** — see B-05's three construction-time asymmetries (`creditApplied` with no voucher; overpayment capping; FX conversion).

**Ripple effects** — I-3 implemented as a hard gate **aborts every legitimate merge**; implemented as a soft check it is **useless**; implemented as a **replay** it silently redefines `paid` and breaks `amountDue` for every merged invoice. There is no fourth option that is safe.

**Remediation reference:** Stage 4, Task 4.6 — downgrade I-3 to a **diagnostic with tolerance**, and never replay `paid`.

---

#### **G-09 — No cross-invariant between an invoice header and its own ledger legs**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | Plan §5f/§5h (`PLAN.md:465`, `:485-494`) |
| **Status** | Design defect. |

**Root cause** — the invariant set checks the ledger against *itself* (I-1) and the invoice against *its lines* (I-2), but **never** checks that an invoice's header agrees with the ledger legs that document produced. In a single-sided, party-scoped ledger model (`ledger_entries.party_id`, no FK to invoices; `reference_id` is a soft polymorphic pointer), **that is the central double-entry invariant.**

**Ripple effects** — the plan §5f applies `update-from-backup` to the invoice header and its lines while *"ledger rows are never updated."* If the backup's invoice has a different total (a genuine edit), the header now contradicts its own ledger legs: **I-2 passes, I-1 passes, and the books are wrong.** Nothing in the proposed battery can catch it.

**Remediation reference:** Stage 4, Task 4.9 — add **I-10** (per imported invoice, `Σ(active legs) == header total`, per currency, 2dp).

---

#### **G-10 — Updating a header and replacing its lines desynchronises stock**

| Field | Value |
|---|---|
| **Severity** | **S1 — Critical** |
| **Scope** | Plan §5f (`PLAN.md:465`) · `0000_baseline.sql:435` · `stock-movement.table.ts:5-10` |
| **Status** | Design defect. |

**Exact location**
```sql
-- 0000_baseline.sql:435
CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE CASCADE,
```
```ts
// stock-movement.table.ts:5-10
/**
 * Stock Movement Ledger — append-only audit trail of every stock change on a roll…
 * Written atomically inside the same transaction that mutates rolls.remaining_kg
 * so the movement can never diverge from the actual stock.
 */
```

**Root cause** — replacing an invoice's lines is a DELETE+INSERT of `invoice_lines`. The plan never mentions `stock_movements` in the apply step (it lists them in the table order and says nothing about replaying them). `stock_movements` has **no FK to invoices** — only to `rolls` (`:1119`) — so nothing cascades and nothing warns.

**Ripple effects** — the roll's `remaining_kg` was already decremented for the *old* lines. Deleting those lines without reversing their movements leaves the counter and the movement history disagreeing, with no constraint to catch it.

**Remediation reference:** Stage 4, Task 4.5 + Task 4.9 — either replay the stock movements in the same transaction, or **refuse to modify** any invoice whose lines carry stock movements (insert-only merges).

---

#### **G-11 — The sync hub is entirely absent from Phase 5**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | Plan §5 (entire) · `backend/src/infrastructure/integrity/hubFingerprint.ts:100-117` · `sync_inbox` / `applied_seq` machinery |
| **Status** | Design defect. |

**Root cause** — this repository has a **cloud hub** with device enrollment, `sync_inbox`, `applied_seq`, and `hubFingerprint` equality proofs (`hubFingerprint.ts:100-117` hashes ledger balances and `rolls.remaining_kg`/`remaining_pieces`). Phase 5 is written as if the hub does not exist.

**Ripple effects** — a Drive merge inserting rows with **original UUIDs** collides head-on with the hub's own replay/idempotency model. Two independent replay systems writing the same tables is a **guaranteed divergence**: the local DB and the hub will disagree, `takeHubFingerprint` equality checks will fail, and the user will see phantom conflicts on every device.

**Remediation reference:** Stage 4, Task 4.10 — specify the hub interaction: merged rows must be pushed with a deterministic `client_operation_id` so the hub's replay is idempotent, and `takeHubFingerprint` equality must be re-established after a merge.

---

#### **G-12 — The plan's party-balance replay is unnecessary work**

| Field | Value |
|---|---|
| **Severity** | **S4 — Low** (efficiency) |
| **Scope** | Plan §5g (`PLAN.md:477`) · `SqliteLedgerRepository.ts:263-287` · `backend/src/infrastructure/orm/migrations/0038_drop_party_balances.sql` |
| **Status** | Design defect (over-engineering). |

**Exact location**
```sql
-- 0038_drop_party_balances.sql:2-10
-- party_balances was a materialized balance cache that was never written to and never read
-- from anywhere in the codebase — pure dead schema… The ledger itself (ledger_entries,
-- status='active') is the single source of truth.
```
```ts
// SqliteLedgerRepository.ts:263-287 — derived at READ time
const balance = (await this.partyIsSupplier(partyId, ctx)) ? c - d : d - c;
```

**Ripple effects** — the plan flags this as `[VERIFY] whether any party balance column is cached`. The answer is **no**: the cache table was dropped. There is nothing to replay. I-1 is therefore true by construction and is a cheap assertion, not a gate. Building a replay here would be **writing to a column that does not exist** — the exact "smuggling data into unrelated columns" failure mode this directive warns against.

**Remediation reference:** Stage 4, Task 4.2 — remove party-balance replay from the design; keep the read-time derivation as the single source of truth.

---

#### **G-13 — The plan's roll-replay formula omits the movements with no invoice parent**

| Field | Value |
|---|---|
| **Severity** | **S2 — High** |
| **Scope** | Plan §5g (`PLAN.md:478`) · `stock-movement.table.ts:5-37` · `SqlitePrintJobRepository.ts:208-215, 477-507` · `helpers/inventoryCountRepository.ts:498, 521` |
| **Status** | Design defect. |

**Root cause** — the plan's enumeration (`initial_kg` − sold `invoice_lines.quantity_kg` + returned `return_lines.quantity_kg` + "stock movements") names invoice-line and return-line sources and then gestures at "stock movements" without enumerating the movement kinds. The kinds with **no invoice parent** are exactly the ones the plan's table ordering cannot easily reconstruct.

**Full movement graph (verified)**
| Business event | Movement kind | Direction | Source |
|---|---|---|---|
| Roll created | `initial` | in | `SqliteRollRepository.ts:133-145` |
| Sale invoice | `invoice_sale` | out | `SqliteInvoiceRepository.ts:515-530` |
| Entry (purchase) invoice | `invoice_entry` | in | `SqliteInvoiceRepository.ts:590-605` |
| Sale return | `return_sale` | in | `SqliteReturnRepository.ts:608-623` |
| Entry return | `return_entry` | out | `SqliteReturnRepository.ts:612-613` |
| **Print send / receive** | `print_send` / `print_receive` | out / in | `SqlitePrintJobRepository.ts:208-215, 477-507` |
| **Manual adjust / inventory count** | `adjustment` | in / out | `SqliteRollRepository.ts:308-320`; `helpers/inventoryCountRepository.ts:521` |

**Ripple effects** — omitting the last two families understates or overstates roll stock. `SqliteRollRepository.ts:156-160` additionally **refuses direct quantity writes** (*"لا يمكن تعديل الكمية المتبقية مباشرة من بطاقة الصبغة"*) — the domain forbids it — so a merge engine must write `stock_movements` **and** the counter in the same transaction, which the plan never specifies.

**Remediation reference:** Stage 4, Task 4.5 — replay from the full `stock_movements` table by kind; write movement + counter atomically.

---

### DOMAIN H — Plan & Documentation Integrity

| ID | Severity | Location | Root cause | Ripple | Ref |
|---|---|---|---|---|---|
| **H-01** | S3 | `pdf_render.rs:1-12` | Module doc written for the *intended* implementation, not the actual one (see E-02) | A future maintainer believes the PDF pipeline works. | Stage 1, T1.5 |
| **H-02** | S3 | `PLAN.md:301` — *"the diff adds only this route"* | The claim was never verified against the actual diff | The diff **also deletes** the TanStack Start footer (A-04). The plan misreports its own evidence. | Stage 1, T1.6 |
| **H-03** | S2 | `PLAN.md:22` (finding G8) | Listed as an open finding, yet the Phase section that should close it claims *"IMPLEMENTED"* | A reader concludes the monthly schedule exists. It does not (D-02). | Stage 2, T2.16 |
| **H-04** | S2 | `PLAN.md:386` — `POST /api/desktop/runtime/archive-artifact` | The plan cites a route that **does not exist** (`desktopRuntime.route.ts` has only `pre-update-backup`, `drive-token`, `shutdown`) | The plan documents a fiction; a reader believes a working seam exists (E-14, D-11). | Stage 3, T3.9 |
| **H-05** | S2 | `PLAN.md:44-70` (§1.1 component map) vs. `§3e` vs. `§4.2` | The plan specifies the **response** path (shell → backend) but never the **request** path (backend → shell) | The architecture cannot function in either direction (E-14). | Stage 3, T3.9 |

---

### DOMAIN I — Process, Scope & Delivery Hygiene

| ID | Severity | Location | Root cause | Ripple | Ref |
|---|---|---|---|---|---|
| **I-01** | S2 | Working tree — 37 modified + 17 untracked (54 entries), none committed | Work was accumulated in the tree without staging or committing | **No checkpoint exists.** A single bad `git checkout`/clean destroys everything. There is no bisectable history for review. | Stage 1, T1.0 |
| **I-02** | S3 | The "ISSUE 1" / "ISSUE 3" changes across 9 frontend files + 2 backend repositories | Archive work and unrelated business-logic work were interleaved in one working tree | Reviewers cannot isolate the archive change; a regression in the pieces-default change would be attributed to the archive. | Stage 1, T1.0 |
| **I-03** | S2 | `SqliteInvoiceRepository.ts:1036-1046` + PG twin | The entry-cost refresh writes a **cached roll column** (`entryPricePerKg`) from app code on invoice edit | This is the **same class of drift** the merge engine must not make worse — a cached derived value written outside its owning transaction. It also has no guard against a partial failure leaving `entryPricePerKg` and `remaining_kg` inconsistent. | Stage 1, T1.0 (separate commit) |
| **I-04** | S2 | `backend/src/infrastructure/orm/sqlite/migrations/` — no `0007` | Migration discipline from `PLAN.md:366-370` was not executed (see B-02) | The schema gate (`npm run typecheck:sqlite`) has no artifact to check; schema changes land without fingerprint regeneration. | Stage 1, T1.3 |

| ID | Severity | Location | Root cause | Ripple | Ref |
|---|---|---|---|---|---|
| **I-05** | S2 | `backend/src/application/use-cases/sync/syncCoverage.ts` · `backend/tests/sync-coverage.test.ts` | The previous agent added the Phase 4 routes `POST /drive/archive/runs` and `POST /drive/archive/runs/:id/cancel` but never registered them in `SYNC_COVERAGE` (SYNC-13: every mutating endpoint must be synced or explicitly exempt) | **The repository's backend suite was RED at the audit baseline** — `sync-coverage.test.ts` failed with *"unregistered mutating endpoints"*. The audit did not itemise it because the backend run was blocked on PostgreSQL; the SQLite run surfaces it. A green-repo claim could not be made. | Stage 1, T1.9 |

---

### §1.9 — Problem Count by Severity

Counted from the catalogue: **66** full-detail entries (Domains A–G, each with a `#### **ID**` heading) plus **9** tabular entries (Domain H: 5, Domain I: 5 — one added during Stage 1). **Total = 75.**

| Severity | Count | IDs |
|---|---:|---|
| **S1 — Critical** | **16** | A-01, A-02, B-01, C-01, C-13, E-01, E-14, G-01, G-02, G-03, G-04, G-05, G-09, G-10, **F-01**, **D-12** |
| **S2 — High** | **37** | A-03, B-02, B-04, C-03, C-04, C-05, C-06, C-07, C-09, C-10, C-12, D-01, D-02, D-04, D-05, D-06, D-07, D-08, D-09, E-04, E-05, E-06, E-07, E-11, E-12, G-06, G-07, G-08, G-11, G-13, H-03, H-04, H-05, I-01, I-03, I-04, **I-05** |
| **S3 — Medium** | **16** | A-04, B-05*, C-02, C-08, C-11, D-03, D-10, D-11, E-02, E-03, E-13, F-02, F-03, H-01, H-02, I-02 |
| **S4 — Low** | **6** | B-03, E-08, E-09, E-10, F-04, G-12 |
| **TOTAL** | **75** | |

\* **B-05 is dual-severity**: S3 as a live defect (pre-existing, `invoices.paid` drift), **S1 as a merge blocker** (it makes the plan's invariant I-3 unimplementable — see G-08). It is counted once, under S3, and cross-referenced from G-08.

**Distribution by domain**

| Domain | Name | Count | Full-detail | Tabular |
|---|---|---:|---:|---:|
| A | Build, contract & permission integrity | 4 | 4 | 0 |
| B | Schema, constraint & data-integrity defects | 5 | 5 | 0 |
| C | Cloud identity, deduplication & network robustness | 13 | 13 | 0 |
| D | Scheduling & run lifecycle | 12 | 12 | 0 |
| E | PDF / PNG rendering engine | 14 | 14 | 0 |
| F | Local archive & functional regression | 4 | 4 | 0 |
| G | Smart merge / reconciliation design flaws | 13 | 13 | 0 |
| H | Plan & documentation integrity | 5 | 0 | 5 |
| I | Process, scope & delivery hygiene | 5 | 0 | 5 |
| | **TOTAL** | **75** | **66** | **9** |

---

## §2 — STAGED & DECOUPLED RESOLUTION PLAN

### STAGE 1 — STOP THE BLEEDING & GREEN THE REPO

**Objective:** Restore the repository's contract integrity. Eliminate every defect that is *observable today* without touching the feature architecture. **No new capability is added in this stage.**

**Entry condition:** none — this stage can start immediately.
**Exit philosophy:** after Stage 1 the repo is **green**, the cancel path works, no user-facing regression remains, and the archive feature is exactly as capable as it was before — no more.

---

#### **Task 1.0 — Commit the working tree in isolated, reviewable units (I-01, I-02, I-03)**

**Scope** `git` only — no source edits.
**Strategy**
1. `git stash push` is **not** used. Instead, commit in this order, each verified green:
   - **Commit 1 — "chore: snapshot the Drive archive plan (docs only)"** → `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md`.
   - **Commit 2 — "fix: archive IPC parity, run-state constraint, and print-send/print-receive mapping"** → Stage 1 code fixes.
   - **Commit 3 — "feat: Drive archive naming engine, folder hierarchy, and upsert keying"** → the archive feature.
   - **Commit 4 — "fix: roll pieces default and entry-cost refresh"** → the "ISSUE 1"/"ISSUE 3" business changes **isolated** (I-02, I-03), so a regression there is never attributed to the archive.
2. Verify each commit independently with the §3 battery before proceeding.

**Safety invariant** — Commit 4's content must be **byte-identical** to the working-tree version of the 7 Tier-P files (42/27 baseline) so that it can be reverted independently of the archive work.

**Exit verification**
```powershell
git log --oneline -4
git diff --numstat HEAD~4 HEAD -- src/components/invoices src/components/parties `
  src/routes/invoices.entry.new.tsx src/routes/invoices.sale.new.tsx src/routes/cashbox.tsx
# Expect the Tier-P delta to be exactly 33 ins / 26 del
```

---

#### **Task 1.1 — Restore Tauri IPC parity (A-01, A-02)**

**Scope** `desktop-app/src-tauri/build.rs` · `desktop-app/src-tauri/capabilities/default.json`
**Deterministic fix** Add the three command names to **both** lists, in the same order as `main.rs`:
```rust
// build.rs APP_COMMANDS
"archive_render_pdf_cmd",
"archive_capture_png_cmd",
"archive_clear_run_cmd",
```
```json
// capabilities/default.json permissions
"allow-archive-render-pdf-cmd",
"allow-archive-capture-png-cmd",
"allow-archive-clear-run-cmd",
```
The `build.rs` app manifest auto-generates `permissions/autogenerated/*.toml`; regenerate them via the normal build, do **not** hand-author them.

**Safety & zero-regression invariants**
- `capabilities/default.json` must remain `"windows": ["main"]` — do **not** widen the window grant as part of this task (A-03 is Stage 3).
- No new permission family is introduced; only three `allow-*` entries matching an existing registered handler.
- The `ipc-acl.test.mjs` third assertion (*"every command the UI or the boot page invokes is registered and granted"*) must still pass — meaning no `invoke("…")` in `src/` or `desktop-app/src-tauri/pages/` may reference an unregistered command.

**Exit verification**
```powershell
node --test desktop-app/scripts/ipc-acl.test.mjs      # MUST PASS
cd desktop-app && npm test                             # MUST PASS
cd desktop-app/src-tauri && cargo check --offline      # MUST PASS
```

---

#### **Task 1.2 — Fix the `cancelled` run state at the schema level (B-01)**

**Scope** `backend/src/infrastructure/orm/sqlite/migrations/0007_drive_archive_runs.sql` (new) · `backend/src/infrastructure/googledrive/archiveRuns.ts` · `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts`

**Deterministic fix** — **schema-first, never by weakening the TS type.** A new migration that:
1. Rebuilds `motard_drive_runs` with `CHECK ("state" IN ('running','done','failed','partial','cancelled'))`.
2. Adds the missing columns (see Task 1.3) in the same migration.
3. Updates the Drizzle schema (`drive-archive.table.ts:64`).
4. Regenerates `0000_baseline.sql` (`backend/scripts/generate-sqlite-baseline.mjs`) and `meta/schema-fingerprint.json` (`backend/scripts/regenerate-fingerprint.mjs`).

> **SQLite `CHECK` constraints cannot be altered in place.** The migration must use the standard table-rebuild pattern (create new → copy → drop → rename) — **not** `PRAGMA writable_schema` hacks and **not** dropping the constraint.

**Safety & zero-regression invariants**
- The SQLite rebuild must preserve every existing row, column, index, and the `motard_drive_runs_pkey` PK.
- `state` values already in the table (`'running'|'done'|'failed'|'partial'`) must all survive the rebuild unchanged.
- **Do not** change `finalState()`'s semantics — the user's cancellation intent must be durably recorded.
- `motard_tx_state` flags and the `0005` ledger/cashbox triggers are **not** touched by this task.

**Exit verification**
```powershell
cd backend && npm run db:migrate                 # apply 0007 cleanly on a seeded DB
cd backend && npm run typecheck:sqlite           # schema + fingerprint gate — MUST PASS
cd backend && npx tsc --noEmit                   # MUST PASS
# Targeted behavioural test (new): cancel a run → DB row state == 'cancelled';
#   route returns 2xx; the run is NOT recorded as 'failed'.
cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-run-progress.test.ts tests/drive-monthly-job.test.ts
```

---

#### **Task 1.3 — Add the missing run columns and stop smuggling progress into JSON (B-02)**

**Scope** same migration file as Task 1.2 · `backend/src/infrastructure/googledrive/archiveRuns.ts` · `monthlyArchiveJob.ts:157-160, 254-263`

**Deterministic fix** Add the columns the plan already specified (`PLAN.md:367`):
```sql
ALTER TABLE motard_drive_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE motard_drive_runs ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE motard_drive_runs ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE motard_drive_runs ADD COLUMN current_file TEXT;
-- period_key already exists (0005); backfill then make it meaningful
```
Populate `period_key` and `trigger` on insert (`monthlyArchiveJob.ts:157-160`), and write `progress_done` / `progress_total` / `current_file` as real columns. The `detail` JSON blob may be **retained** for diagnostics, but it must no longer be the *only* carrier of progress.

**Safety & zero-regression invariants**
- `period_key` must be backfilled for existing rows (`UPDATE … SET period_key = substr(started_at,1,7) WHERE period_key IS NULL`) before any NOT NULL constraint is considered.
- The `motard_drive_runs_kind` CHECK (`'documents'|'month_close'|'db_backup'|'catchup'`) is **not** altered in this task — `kind`/`trigger` semantics are reconciled in Stage 2 (Task 2.22), where a controlled migration is safer.
- The device-bound exclusion list in `sqliteBackup.ts:37-50` must continue to exclude `motard_drive_*` — new columns must not leak into backups.

**Exit verification**
```powershell
cd backend && npm run typecheck:sqlite                     # MUST PASS
cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-run-progress.test.ts tests/drive-monthly-job.test.ts tests/drive-archive-runs.test.ts
cd backend && npx vitest run tests/sqlite/backup-roundtrip.test.ts   # backups unaffected
```

---

#### **Task 1.4 — Fix the cashbox snapshot outflow calculation (B-04)**

**Scope** `src/routes/archive-snapshot.tsx:62-63`
**Deterministic fix** Mirror the server's convention (`cashboxBalanceHelper.ts:36-42`: `COALESCE(debit,0) + COALESCE(credit,0)`) rather than `??`:
```tsx
cashIn:  e.cashImpact === "in"  ? Math.abs(Number(e.debit ?? 0) + Number(e.credit ?? 0)) : 0,
cashOut: e.cashImpact === "out" ? Math.abs(Number(e.debit ?? 0) + Number(e.credit ?? 0)) : 0,
```
No `||` fallback and no `??` on a non-nullable column.

**Safety & zero-regression invariants**
- The server remains the single source of truth for the cashbox; this is a **rendering** fix only.
- The existing 19 `archiveDocuments` tests must still pass — they assert the builder, not this mapping, so this fix adds coverage rather than changing it.
- **Add** a regression test asserting a `cash_impact='out'` row with `debit=0, credit=500` renders `500.00` (this is the test that would have caught the bug).

**Exit verification**
```powershell
npx vitest run src/components/print/__tests__/archiveDocuments.test.ts
npx tsc --noEmit
```

---

#### **Task 1.5 — Correct the false module documentation (E-02, H-01)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs:1-12, 156-157`
**Deterministic fix** Rewrite the module doc to describe the **actual** state: the renderer is a stub; `PrintToPdf`/`CapturePreview` are **not** wired; the backend runtime route does not exist; the command names are `archive_render_pdf_cmd` / `archive_capture_png_cmd`. Add a `// TODO(Stage 3):` marker naming the tasks that will complete it.

**Safety & zero-regression invariants** — comment-only change; no code path is affected. This is precisely why it belongs in Stage 1: it is free, and it removes the single most misleading artefact in the change set.

**Exit verification** `cd desktop-app/src-tauri && cargo check --offline` (no new warnings).

---

#### **Task 1.6 — Regenerate `routeTree.gen.ts` with the project's own generator (A-04, H-02)**

**Scope** `src/routeTree.gen.ts`
**Deterministic fix** Run the project's TanStack Start route generator so the committed artifact matches generator output **including** the `Register` footer. Verify the diff is **additive only** for the `archive-snapshot` route.

**Safety & zero-regression invariants** — `src/start.ts` and `src/router.tsx` must remain untouched; `src/routeTree.gen.ts` is a generated artefact and must never be hand-edited.

**Exit verification**
```powershell
npx tsc --noEmit
git diff src/routeTree.gen.ts   # footer must be PRESENT
```

---

#### **Task 1.7 — Restore `print_send` / `print_receive` archiving and add exhaustive parity (F-01)**

**Scope** `desktop-app/src-tauri/src/commands.rs:145-154, 455` · `src/infrastructure/tauri-bridge.ts:129`
**Deterministic fix**
1. Re-add the two document types to `category_for_doc_type`, mapped to their correct shared categories.
2. **Decide the category** in `packages/shared/src/archivePaths.ts` — the six categories are `entry_invoices`, `sale_invoices`, `returns`, `statements`, `cashbox`, `system_backups`. `print_send`/`print_receive` are print jobs, not invoices. **They must not be silently folded into `sale_invoices`.** Either (a) add a 7th category `print_jobs` (requires updating the shared module, the Rust constant, and the parity test), or (b) map them to the closest existing category **and document the decision**. The recommended route is (a) — a print job is a distinct document class, and hiding it inside "sale invoices" corrupts the archive's semantics.
3. Add an **exhaustive** Rust test that enumerates every `ArchiveDocType` string in `src/infrastructure/tauri-bridge.ts:129` (parsed at compile time via `include_str!`, as the existing category test does) and asserts each maps to a non-`None` category.

**Safety & zero-regression invariants**
- The six shared categories and their Arabic labels must remain unchanged unless option (a) is taken, in which case `packages/shared/src/archivePaths.ts` and `desktop-app/src-tauri/src/commands.rs` must change **together** and the parity test must be extended to a bidirectional key+label comparison.
- `ArchiveDocType` in `tauri-bridge.ts` must continue to include every type the print routes emit (`invoices.print-send.new.tsx:268`, `invoices.print-receive.new.tsx:309`).
- The existing `"payroll"`-is-refused assertion must still hold.

**Exit verification**
```powershell
cd desktop-app/src-tauri && cargo test -j1              # MUST PASS, incl. the new parity test
npx vitest run src/components/print/                   # print portal tests MUST PASS
```

---

#### **Task 1.8 — Strengthen the category parity test to bidirectional key+label comparison (F-04)**

**Scope** `desktop-app/src-tauri/src/commands.rs:438-447`
**Deterministic fix** Replace the one-directional `Rust ⊆ TS` label-substring check with a parse of **both** key+label pairs and a `deepEqual`-style comparison in both directions, including a duplicate-label guard.

**Safety & zero-regression invariants** — the test must remain compile-time (`include_str!`), so it cannot drift from the TS source.

**Exit verification** `cd desktop-app/src-tauri && cargo test -j1`.

---

### 🛑 STAGE 1 EXIT GATE

**All of the following MUST be green. Any failure blocks Stage 2.**

```powershell
# 1. Contract integrity — THE regression that opened this audit
node --test desktop-app/scripts/ipc-acl.test.mjs          # MUST PASS (was RED)

# 2. Desktop shell
cd desktop-app && npm test                                  # MUST PASS
cd desktop-app/src-tauri && cargo test -j1                 # MUST PASS
cd desktop-app/src-tauri && cargo check --offline           # MUST PASS, no new warnings

# 3. Schema
cd backend && npm run typecheck:sqlite                     # MUST PASS (schema + fingerprint)

# 4. Types + lint
npx tsc --noEmit                                           # MUST PASS
cd backend && npx tsc --noEmit                             # MUST PASS
npm run lint                                               # MUST PASS, 0 warnings
cd backend && npm run lint                                 # MUST PASS, 0 warnings

# 5. Tests
npx vitest run                                             # MUST PASS (read the summary line)
cd backend && DB_ENGINE=sqlite npx vitest run              # MUST PASS

# 6. Protected files — must be UNCHANGED from the §0.2 baseline
git diff --numstat -- <the 9 protected files>              # MUST equal 42 ins / 27 del

# 7. Cancel path — behavioural proof
#    (a) cancel a run → HTTP 2xx, DB state == 'cancelled', NOT 'failed'
```

**Stage 1 deliverable statement:** *the repository is green, no user-facing regression remains, and the archive feature's capability is unchanged from its pre-audit state.*

---

### STAGE 2 — CLOUD IDENTITY & DEDUPLICATION HARDENING

**Objective:** Make the archive's *identity* immutable and its *scheduling* single-owner. This stage converts the Drive archive from "probably works" to "provably correct under rename, cancel, renumber, folder recreation, multi-install, and network failure."

**Entry condition:** Stage 1 exit gate green.
**Exit philosophy:** an edited invoice produces **exactly one** Drive file, under **any** sequence of business changes.

---

#### **Task 2.1 — Key the archive on the immutable document UUID (C-01, C-02)**

**Scope** `backend/src/infrastructure/googledrive/exporters.ts:76-146` · `monthlyArchiveJob.ts:167-187` · `uploadQueue.ts:74-86` · `packages/shared/src/archivePaths.ts:128-132`
**Deterministic fix**
1. `exporters.ts` already selects `invoices.id` (`:83`) — **propagate it** through `monthFiles` → `queue.enqueue` → the queue row's `entityId` field (or a new dedicated `documentId` field).
2. `documentKey` must be built from the **UUID**, not the filename:
   ```ts
   documentKey = appKey({ tenantId: <REAL tenant id>, docType: `${section}:${entityType}`, documentId: entityId /* the UUID */ })
   ```
3. The **filename** remains derived from the business fields (it is for humans) but must be stored separately from the **identity**.
4. Because the file name changes on rename/cancel, `updateMedia` must also refresh the Drive name (Task 2.4) so the on-disk name stays truthful.

**Safety & zero-regression invariants**
- The existing `stableKey` content-hash dedupe (`uploadQueue.ts:111-136`) must continue to work unchanged — it is a *different* key (content) and provides the "unchanged → skip" optimisation.
- `packages/shared/src/archivePaths.ts` `appKey` must keep its `|`-joined, stable, test-covered shape (25 tests) — only the **inputs** change.
- The `motard_drive_uploads` schema gains a column to carry the document id → **migration required**, with fingerprint regeneration.

**Exit verification**
```powershell
cd backend && npm run typecheck:sqlite
cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-upload-queue.test.ts tests/drive-monthly-job.test.ts
npx vitest run packages/shared/src/archivePaths.test.ts     # 25 tests MUST PASS
```

---

#### **Task 2.2 — Use the real tenant id in the upsert key (C-05)**

**Scope** `backend/src/infrastructure/googledrive/uploadQueue.ts:82` · `monthlyArchiveJob.ts` (the enqueue call site)
**Deterministic fix** Thread the actual `tenantId` through the queue row into `documentKey`. The literal `"archive"` is removed entirely.

**Safety & zero-regression invariants**
- `appKey` shape unchanged.
- A **migration** is required to add the column; existing rows backfill from `tenants`.
- The `tenantId` used must be the **same** tenant context the queue already uses for authorisation (`authorizeUploadDevice`), so a non-primary device cannot mint keys for another tenant.

**Exit verification** `cd backend && npm run typecheck:sqlite` · targeted drive tests.

---

#### **Task 2.3 — Make the upsert lookup global with a parent-scoped fallback (C-03)**

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts:186-196` · `uploadQueue.ts:271`
**Deterministic fix** Query `appProperties` **globally** first (`motardKey` is unique by construction). Keep the parent-scoped query as a **fallback** only if the global query is unavailable, and log the fallback.

**Safety & zero-regression invariants**
- The `trashed = false` filter must be preserved.
- The query must remain a **read** operation with no side effects on Drive.
- No new Drive API surface (no `files.list` corpus) — the existing scoped list is retained.

**Exit verification** `cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-upload-queue.test.ts`.

---

#### **Task 2.4 — Refresh the Drive file name and `modifiedTime` on update (C-04)**

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts` (`updateMedia`) · `uploadQueue.ts:273`
**Deterministic fix** After `PATCH …?uploadType=media`, issue a metadata `PATCH /drive/v3/files/{id}` with `{ name, modifiedTime }`. Name is derived from the same `archivePaths.documentFileName` used for creation.

**Safety & zero-regression invariants**
- `updateMedia` must stay **idempotent** — the same document re-uploaded twice yields the same name and content.
- The file **id** must never change on update (that is the whole point of the upsert).
- `appProperties` must be preserved across the metadata PATCH (Drive semantics — verify explicitly).

**Exit verification** a new test asserting: given an existing file, an upload with changed content **updates the same id** **and** sets the new name.

---

#### **Task 2.5 — Add the missing "found → updateMedia" test (C-06)** ⭐

**Scope** `backend/tests/drive-upload-queue.test.ts` · a new Drive-like fake
**Deterministic fix** Replace the always-`null` `findByAppKey` fake with a **stateful** fake that:
1. Stores files by `appProperties.motardKey`.
2. Returns the stored file on the second upload of the same key.
3. Asserts: **same file id**, **updated content**, **updated name**, **exactly one file in the fake**.

**This is the highest-value single test in the entire remediation.** Without it, the feature's headline behaviour is unverified.

**Safety & zero-regression invariants** — the existing 79 Drive tests must all still pass; the fake must not become a shared singleton across test files (isolation).

**Exit verification** `cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-upload-queue.test.ts tests/drive-archive-pipeline.test.ts` — MUST PASS, and **must now exercise the update branch**.

---

#### **Task 2.6 — Deduplicate the `stableKey`/content-hash interaction with the new identity (C-01 cont.)**

**Scope** `backend/src/infrastructure/googledrive/uploadQueue.ts:111-136, 266-276`
**Deterministic fix** Ensure the two mechanisms compose correctly: `stableKey` = *content* identity (skip if byte-identical); `motardKey` = *document* identity (update if the document changed). A document whose content changed must **update**, not create; a document whose content is unchanged must **skip** without a Drive write.

**Safety & zero-regression invariants** — the existing hash-skip test must still pass; the new update test must not regress it.

---

#### **Task 2.7 — Replace the `passInFlight` boolean with an atomic run guard (C-07)**

**Scope** `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:134,149,151,156,272`
**Deterministic fix** Use a **DB-backed lease** on `motard_drive_runs` (a `lease_token`/`lease_until` pair, mirroring the proven `uploadQueue.claim()` CAS pattern at `uploadQueue.ts:203-247`) instead of an in-process boolean. The check-and-set becomes a single atomic `UPDATE … WHERE id = ? AND (lease_until IS NULL OR lease_until < now)`.

**Safety & zero-regression invariants**
- The `uploadQueue` lease semantics (CAS with `leaseToken`/`leaseUntil`) are the reference implementation — copy the pattern, do not invent a second one.
- The `finally { passInFlight = false }` must be replaced by an equivalent **release** that cannot release another run's lease.

**Exit verification** a new concurrency test: two simultaneous `runArchivePass` calls → exactly one performs work, the other returns a distinguishable `BUSY`.

---

#### **Task 2.8 — Propagate the skip reason to the client (C-08)**

**Scope** `backend/src/presentation/driveArchiveWiring.ts:58-61`
**Deterministic fix** Return the full `runArchivePass` result including `skipped` (`"BUSY" | "NOT_COORDINATOR" | "NOT_CONNECTED"`), and surface it in the route response and in `src/lib/drive-archive.ts`'s `syncNow` type.

**Safety & zero-regression invariants** — the response must remain backward-compatible (`ok`, `queued`, `started` all still present) so existing UI code does not break.

**Exit verification** `npx tsc --noEmit` · `cd backend && npx tsc --noEmit` · targeted route test.

---

#### **Task 2.9 — Resolve the dead `revision` column (B-03)**

**Scope** `backend/src/infrastructure/orm/sqlite/schemas/drive-archive.table.ts:48`
**Deterministic fix** Either populate `revision` with a meaningful monotonic counter (useful for detecting out-of-order queue updates), or drop it in the next migration. **Decide and record the decision.**

**Exit verification** `cd backend && npm run typecheck:sqlite`.

---

#### **Task 2.10 — Refresh the access token on 401 (C-09)**

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts:132-179` · `backend/src/presentation/routes/desktopRuntime.route.ts:60` (`/drive-token`)
**Deterministic fix** On a 401, call the existing runtime token endpoint (or an injected `refreshToken` callback) to re-mint, then **retry the request once** with the new token. Only after the second failure raise `DriveAuthError`.

**Safety & zero-regression invariants**
- The refresh must be **single-flight** — concurrent 401s must trigger **one** refresh, not N.
- The refresh must never recurse into the retry loop.
- The `DriveAuthError` → `blocked` job behaviour (`uploadQueue.ts:372-384`) must remain for genuine auth failures.

**Exit verification** a new test: a fake that returns 401 on the first call and succeeds after a refresh → the request succeeds.

---

#### **Task 2.11 — Add request timeouts (C-10)**

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts:132-179`
**Deterministic fix** Apply `AbortSignal.timeout(ms)` to every Drive request, with a per-request budget compatible with the existing exponential backoff (`500 * 2**attempt`).

**Safety & zero-regression invariants**
- The timeout must be **larger** than the total backoff window for the configured retries, so a slow-but-alive request is not aborted prematurely.
- The resumable PUT loop has its own timing semantics and must be reviewed separately.

**Exit verification** a new test using a hanging fake → the call rejects with a timeout error within the budget.

---

#### **Task 2.12 — Add retry to the resumable session init (C-11)**

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts:286-343`
**Deterministic fix** Route the session-init POST through the same `request()` helper (which already has backoff + 429/5xx handling) as the other calls.

**Safety & zero-regression invariants** — the streaming PUT loop's existing behaviour must be preserved exactly.

**Exit verification** targeted drive tests.

---

#### **Task 2.13 — Verify uploads by content hash (C-12)**

**Scope** `backend/src/infrastructure/googledrive/uploadQueue.ts:282-283` · `driveClient.ts` (`getFile`)
**Deterministic fix** Compare the uploaded content's hash against Drive's `md5Checksum` (or the Drive-side `sha256` where available) **before** marking the job `done`. A mismatch → the job fails with a distinct error, not a generic retry.

**Safety & zero-regression invariants**
- Verification must happen **after** the upload completes and **before** the row is marked `done`.
- A mismatch must **not** be recorded as a transient failure that silently retries into a permanent loop.

**Exit verification** a new test: a fake returning a wrong `md5Checksum` → the job does **not** reach `done`.

---

#### **Task 2.14 — Add the download capability (C-13)** ⭐

**Scope** `backend/src/infrastructure/googledrive/driveClient.ts` (new `downloadToFile`) · a new `driveDownload.ts`
**Deterministic fix** `GET /drive/v3/files/{id}?alt=media`, **streamed** to `<out>.partial`, hashed while streaming, renamed to the final path **only on hash match**. Reuse `request()`'s retry and `DriveAuthError` mapping.

**Safety & zero-regression invariants**
- Never write directly to the final path — the `.partial` + rename is the crash-safety pattern already used elsewhere in this repo.
- The stream must not buffer the whole file in memory (the backup ZIP can be hundreds of MB).
- The 401-refresh path (Task 2.10) must apply.

**Why Stage 2, not Stage 4** — this is a hard prerequisite for the merge engine, and it also closes C-12 and enables "re-download and repair". Building it after the merge design would invert the dependency.

**Exit verification** a new test: download a fake file → byte-identical content; a hash mismatch → no file at the final path.

---

#### **Task 2.15 — Consolidate to a single scheduler owner (D-01, D-03)**

**Scope** `desktop-app/src-tauri/src/archive_scheduler.rs` · `main.rs` · `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:297-308`
**Deterministic fix — decide, then implement ONE of:**
- **Option A (recommended): the backend owns the schedule.** Delete `archive_scheduler.rs` entirely; implement month-end + catch-up in `monthlyArchiveJob.ts` using the now-durable `period_key`/`trigger` columns from Task 1.3. **Rationale:** the backend already owns the run table, the primary-device gate (`authorizeUploadDevice`), the queue, and the lease. A Rust scheduler would need all of those proxied over the pipe for no benefit.
- **Option B: the shell owns the schedule.** Wire `archive_scheduler::start()` in `main.rs` with real closures over `pipe::request`, and **delete the backend's 6-hour archive worker**.

**Under either option, exactly one scheduler must remain.** Leaving both is prohibited — the backend's `passInFlight` would silently swallow one of them, producing the exact "the month never archived" symptom the feature exists to prevent.

**Safety & zero-regression invariants**
- The primary-device gate stays in the backend. The shell must never decide primary status.
- The Drive token loop (`boot.rs:355-360`) is unaffected.
- If Option A, `archive_scheduler.rs`'s 9 well-written `decide()` unit tests must be **ported** to TypeScript, not simply discarded — they encode real period logic.

**Exit verification** a new test for the period-decision function covering: month end, catch-up after 3 days offline, already done, manual trigger.

---

#### **Task 2.16 — Replace the 24-month × 6-hour rescan with a coverage-driven schedule (D-02, H-03)**

**Scope** `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts:50-51, 167-187, 297-308`
**Deterministic fix**
1. Compute the set of **uncovered** periods from the durable `motard_drive_runs` rows (`period_key` populated + `state='done'`), not a blind 24-month window.
2. Archive only the uncovered periods (plus the current month if the user opts into a rolling archive).
3. Persist `period_key` + `state='done'` so the next tick is a **no-op**.
4. Remove the per-job `regenerate()` re-export (`:119-132`) — the `O(jobs × months)` amplification must be eliminated by caching the month's export per pass.

**Safety & zero-regression invariants**
- `CATCHUP_MONTHS = 24` remains the **upper bound** on how far back the scheduler will look on a fresh install — that protective behaviour must be preserved.
- The `stableKey` content-hash dedupe remains the second line of defence for anything still re-enqueued.
- A fresh install on an empty `motard_drive_runs` table must still walk back 24 months exactly once.

**Exit verification** a new test: two consecutive ticks → the second performs **zero** DB queries for months already `done`.

---

#### **Task 2.17 — Fire the month-end archive after the period closes (D-04)**

**Scope** the period-decision function (Task 2.15)
**Deterministic fix** The archive for period *M* must trigger **after** *M* ends — e.g. on the 1st of *M+1* — never at 00:xx on the last day of *M*.

**Safety & zero-regression invariants** — the current-period archive (if the user wants a rolling archive) must be explicitly distinguished from the closed-period archive, and must be labelled as provisional.

**Exit verification** a decision-table test: `2026-10-31 23:59` → not yet; `2026-11-01 00:05` → yes for `2026-10`.

---

#### **Task 2.18 — Walk back all uncovered periods, not one (D-05)**

**Scope** the period-decision function (Task 2.15)
**Deterministic fix** Return the **ordered list** of uncovered periods, not a single `due` month.

**Safety & zero-regression invariants** — the 24-month bound (Task 2.16) still applies; the list must be deterministic and ordered oldest-first.

**Exit verification** a decision-table test: desktop off for 3 months → all 3 periods returned, oldest first.

---

#### **Task 2.19 — Honour `{trigger, periodKey}` in the run route (D-06, D-10)**

**Scope** `backend/src/presentation/routes/drive.route.ts:202-211` · `monthlyArchiveJob.ts:157-160`
**Deterministic fix** Parse the body; persist `trigger` and `period_key`; pass `periodKey` into `runArchivePass`.

**Safety & zero-regression invariants** — `trigger` must be validated against an allow-list (`monthly` | `catchup` | `manual` | `connect`); an unknown value is rejected with 400, not coerced.

**Exit verification** a new route test asserting the row's `trigger`/`period_key` match the request body.

---

#### **Task 2.20 — Make the run route asynchronous and return a `runId` (D-07, D-08)**

**Scope** `backend/src/presentation/routes/drive.route.ts:202-211`
**Deterministic fix** Create the run row, enqueue the work, and **respond immediately** with `202 { runId }`. The pass must not be awaited inside the request handler.

**Safety & zero-regression invariants**
- `refuseIfNotPrimary` and `adminGuard` must still run **before** the run is created.
- The `Idempotency-Key` decision from `PLAN.md:381` must be resolved explicitly (recommended: **required**, to make double-clicks harmless).
- The response must include `runId` so the progress route is reachable.

**Exit verification** a new route test: `POST` returns in <100 ms with a `runId`; `GET /drive/archive/runs/:runId` returns progress.

---

#### **Task 2.21 — Persist run progress durably (D-09, B-02 cont.)**

**Scope** `backend/src/infrastructure/googledrive/archiveRuns.ts:82-119` · `monthlyArchiveJob.ts`
**Deterministic fix** The progress read path must query the **durable** columns (Task 1.3), with the in-memory map used only as a write-through cache.

**Safety & zero-regression invariants** — `MAX_KEPT` eviction must not lose durable rows.

**Exit verification** a new test: progress survives a simulated backend restart.

---

#### **Task 2.22 — Reconcile `kind` and `trigger` semantics (D-10)**

**Scope** `backend/src/infrastructure/orm/sqlite/migrations/0007*.sql` · `monthlyArchiveJob.ts:159`
**Deterministic fix** `kind` describes the **artefact class** (`documents` | `month_close` | `db_backup`); `trigger` describes the **origin** (`monthly` | `catchup` | `manual` | `connect`). Write both correctly. The existing `kind` CHECK is retained.

**Safety & zero-regression invariants** — existing rows keep a valid `kind`; backfill `trigger` as `'manual'` or `'catchup'` per the plan's intent.

**Exit verification** `cd backend && npm run typecheck:sqlite` · targeted drive tests.

---

#### **Task 2.23 — Pass the business period to `ensureDocumentFolders` (F-02)**

**Scope** `src/components/print/printPortal.ts:224`
**Deterministic fix** `await ensureDocumentFolders(companyName, meta.period)`.

**Safety & zero-regression invariants** — `meta.period` is optional (`documentArchive.ts:43-45`); when absent, the current month is used (the Rust default already does this).

**Exit verification** `npx vitest run src/components/print/`.

---

#### **Task 2.24 — Align the local archive root with the shared naming engine (F-03)**

**Scope** `desktop-app/src-tauri/src/commands.rs:174-177` · `packages/shared/src/archivePaths.ts:57-61`
**Deterministic fix** Make the Rust root use the shared `companyFolderName` output (`<company> - أرشيف النظام`) and the shared `sanitizeSegment` rules. The shared module is the single source of truth; the Rust side must mirror it.

**Safety & zero-regression invariants**
- Existing installs have a `Desktop\<company>\` folder. The change must **migrate** it (rename the existing folder in place, or create the new root and move the tree) — **not** leave two trees behind.
- The Drive side already uses `companyFolderName` (`folderOrganizer.ts:39`) — the two must agree.

**Exit verification** a Rust test asserting the local root name equals the shared module's output for a set of hostile company names (spaces, path separators, RTL).

---

### 🛑 STAGE 2 EXIT GATE

```powershell
# Identity & dedup — the headline capability
cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-upload-queue.test.ts `
  tests/drive-archive-pipeline.test.ts tests/drive-monthly-job.test.ts `
  tests/drive-run-progress.test.ts tests/drive-streamed-upload.test.ts
# MUST PASS, and MUST now exercise the found→updateMedia branch (Task 2.5)

# New coverage
cd backend && DB_ENGINE=sqlite npx vitest run tests/drive-archive-runs.test.ts
# MUST PASS, incl. the new tests for: 401-refresh, timeout, hash-mismatch,
#   download round-trip, runId return, trigger/period persistence, progress-after-restart

# Scheduling
# MUST PASS: a test proving two consecutive ticks perform zero redundant work;
#   and that 3-month catch-up returns all 3 periods

# Schema
cd backend && npm run typecheck:sqlite                     # MUST PASS

# Types, lint, full suites
npx tsc --noEmit                                           # MUST PASS
cd backend && npx tsc --noEmit                             # MUST PASS
npm run lint && cd backend && npm run lint                 # 0 warnings
npx vitest run                                             # MUST PASS
cd backend && DB_ENGINE=sqlite npx vitest run              # MUST PASS

# Desktop
cd desktop-app && npm test && cd src-tauri && cargo test -j1   # MUST PASS

# Protected files
git diff --numstat -- <the 9 protected files>              # MUST equal 42 ins / 27 del

# No scheduler duplication — static proof
rg -n "archive_scheduler::" desktop-app/                    # MUST be empty (Option A) or wired (Option B)
rg -n "TICK_MS|CATCHUP_MONTHS" backend/src/infrastructure/googledrive/monthlyArchiveJob.ts
```

**Stage 2 deliverable statement:** *an edited, renamed, cancelled, or renumbered invoice produces exactly one Drive file, under exactly one tenant, in exactly one folder — and the monthly archive runs once per period, after the period closes, with full catch-up.*

---

### STAGE 3 — COMPLETE THE PDF / PNG ENGINE

**Objective:** Replace the stub with a real renderer and close the backend↔shell architectural hole.

**Entry condition:** Stage 2 exit gate green. **Prerequisite:** a physical Windows desktop with the WebView2 runtime — this stage **cannot** be validated on CI alone.

> **⚠️ Spike-first discipline (per `PLAN.md:318`).** The plan itself declares the WebView2 spike **blocking** before any other 3x work. It was not done. Task 3.0 must be executed and reported **before** Task 3.1 is committed.

---

#### **Task 3.0 — Execute the WebView2 spike on a physical desktop (blocking)**

**Scope** a throwaway branch / scratch crate — **no production code**.
**Deterministic fix** On a real Windows machine: create a hidden `WebviewWindow`, obtain the `ICoreWebView2Controller` via `with_webview`, `cast::<ICoreWebView2_7>()`, construct `ICoreWebView2PrintSettings`, and call `PrintToPdf` with a completion handler. Separately exercise `CapturePreview` with an `IStream`.

**Acceptance criteria (from `PLAN.md:320`, with the gap closed)**
1. Arabic RTL text shapes correctly (no tofu).
2. `@page` size matches A4/A5 — **verified by measuring the produced PDF's page box**, not by assumption.
3. The output PDF's page count equals the expected count for a multi-page invoice.
4. PNG at 2× device scale.
5. **The render completes on a background thread without freezing the UI** (a visible window must remain responsive during the render).
6. Fonts are fully loaded before capture (no missing-glyph PDF).

**Exit verification** a written spike report with the produced sample PDF/PNG, the measured page box, and the COM call sequence that worked.

---

#### **Task 3.1 — Replace the error stub with the real COM calls (E-01, E-06, E-07)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs:188-210`
**Deterministic fix**
1. `core.cast::<ICoreWebView2_7>()` → `PrintToPdf(path, ICoreWebView2PrintSettings, ICoreWebView2PrintToPdfCompletedHandler)`.
2. `ICoreWebView2::CapturePreview(PNG, IStream, ICoreWebView2CapturePreviewCompletedHandler)`.
3. Both are **asynchronous**: the completion handler must bridge to the Rust caller (a `std::sync::mpsc` channel or a `tokio::oneshot`), replacing the current synchronous `-> Vec<u8>` shape.
4. `PrintToPdf` writes to a **file path**; the PDF bytes are then read back from disk (this is also how the SHA-256 is computed — see Task 3.5).

**Safety & zero-regression invariants**
- The staging directory layout, run-id validation, and filename validation (`pdf_render.rs:59-88`) are **unchanged** — they are correct and tested.
- `validate_out_name` must continue to reject path separators, `..`, and wrong extensions.
- The renderer must write **only** inside `archive-staging\<runId>\`.

**Exit verification** `cd desktop-app/src-tauri && cargo test -j1` + a real render producing a non-empty PDF with a correct SHA-256.

---

#### **Task 3.2 — Settle the render contract: HTML string vs. URL (E-12)**

**Scope** `desktop-app/src-tauri/src/commands.rs:261-283` · `src/routes/archive-snapshot.tsx` · `src/components/print/archiveDocuments.ts`
**Deterministic fix — decide one:**
- **Option A (recommended): HTML string.** The frontend builds the complete document with `wrapArchiveDocument` (`archiveDocuments.ts:31`) and passes it to the command. The renderer never loads the SPA. **Simpler, deterministic, no IPC rights needed for the hidden window, no route dependency.**
- **Option B: URL.** The renderer navigates to `…/archive-snapshot?period=…` and the route must render a **full document** (not a fragment) and the hidden window **must** be granted capabilities (A-03).

Under **either** option, `src/routes/archive-snapshot.tsx` must be updated to produce a complete document (or be deleted if Option A makes it unnecessary), and `wrapArchiveDocument` must be used in production, not only in tests.

**Safety & zero-regression invariants** — `buildArchiveHtml` in `printPortal.ts:191-218` remains the **local HTML archive** path and must not be broken by this change.

**Exit verification** a test asserting the rendered HTML contains `<html>`/`<head>`/the Arabic font CSS and no external resource references.

---

#### **Task 3.3 — Bridge the async COM handlers (E-06, E-07 cont.)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs`
**Deterministic fix** Implement the completion handlers as `windows::core::Interface` implementations that send the result over a channel; the blocking wrapper awaits the channel with a **bounded** timeout.

**Safety & zero-regression invariants**
- The timeout must be **bounded** (the existing `recv_timeout(60s)` is the precedent) and must **release** the hidden window on timeout — a leaked hidden window per failed render would accumulate.
- The COM objects must be released deterministically.

**Exit verification** a test that forces a timeout and asserts the window is released.

---

#### **Task 3.4 — Wait for real readiness, not a sleep (E-04)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs:202`
**Deterministic fix** Subscribe to `NavigationCompleted` on the `ICoreWebView2`, and inject a readiness script that resolves a promise on `document.fonts.ready`; await both before capturing.

**Safety & zero-regression invariants**
- The injected script must not reference any network resource (the archive documents are fully self-contained — the existing builders assert `not.toMatch(/https?:\/\//)`).
- The wait must have a **bounded** fallback so a document that never signals does not hang the render.

**Exit verification** a render on a cold font cache produces a PDF with correct Arabic glyphs (verified by a human or by a glyph-presence check).

---

#### **Task 3.5 — Apply the paper size and hash the staged bytes (E-03)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs:40-45, 89-104, 150-152`
**Deterministic fix**
1. Feed `Paper::inches()` into `ICoreWebView2PrintSettings` (page size in inches) — this is what `inches()` was written for.
2. Compute the SHA-256 from the **staged file's bytes** (`measure` at `:89` already does this correctly).
3. Return `{path, sha256, sizeBytes, pages}`.

**Safety & zero-regression invariants**
- `Paper::parse` must keep rejecting unknown paper names.
- `measure` must hash the file on disk, not the in-memory buffer (they must agree).

**Exit verification** a test asserting the produced PDF's page box matches A4 (595.28 × 841.89 pt) / A5.

---

#### **Task 3.6 — Move the render off the UI thread (E-05)**

**Scope** `desktop-app/src-tauri/src/commands.rs:261, 275`
**Deterministic fix** Make the commands `async` and execute the blocking work via `tauri::async_runtime::spawn_blocking`, so the IPC thread and the main event loop are never occupied for the render duration.

**Safety & zero-regression invariants**
- `with_webview` must be called from the **main thread** (Tauri requires it for the webview controller); the design must obtain the controller on the main thread and do the blocking COM work off it, or use `with_webview`'s closure correctly.
- The UI must remain responsive during a batch render (a measured assertion in the spike, Task 3.0).

**Exit verification** a manual observation during a 20-document render: the window stays responsive.

---

#### **Task 3.7 — Free the `PWSTR` allocation (E-08)**

**Scope** `desktop-app/src-tauri/src/pdf_render.rs:200`
**Deterministic fix** Use `CoTaskMemPWSTR` and call `take_pwstr()` to release the buffer after `NavigateToString`.

**Exit verification** `cargo clippy` / a memory check shows no growth over 100 renders.

---

#### **Task 3.8 — Grant the hidden window the capabilities it needs (A-03)**

**Scope** `desktop-app/src-tauri/capabilities/default.json` · `pdf_render.rs:160-165`
**Deterministic fix** If Task 3.2 selects **Option B** (URL), add a capability entry matching the `archive-render-*` window label. If **Option A**, document explicitly that the hidden window requires **no** IPC rights, and add a comment in the capability file recording that decision.

**Safety & zero-regression invariants** — under Option A the capability file must **not** be widened. Under Option B the grant must be **minimal** (the hidden window needs only what the snapshot route requires).

**Exit verification** `node --test desktop-app/scripts/ipc-acl.test.mjs` MUST PASS.

---

#### **Task 3.9 — Build the backend→shell render-request channel (E-14, D-11, H-04, H-05)** ⭐

**Scope** `backend/src/presentation/routes/desktopRuntime.route.ts` · `backend/src/presentation/driveArchiveWiring.ts:29` · `backend/src/infrastructure/googledrive/archiveBundle.ts` · `backend/src/infrastructure/googledrive/monthlyArchiveJob.ts`
**Deterministic fix** Design and implement the **missing half** of the handshake:
1. **Request path (new):** the backend must be able to ask the shell to render. Two viable shapes:
   - **(a) Shell-initiated pull:** the shell polls `GET /api/desktop/runtime/archive-render-requests?runId=…` (long-poll), the backend queues render requests. **Recommended** — it reuses the shell's existing startup/poll machinery and needs no inbound channel into the Rust event loop.
   - **(b) Backend-initiated push:** the shell opens a callback channel to the backend. More complex; introduces a reverse-connection lifecycle.
2. **Response path (planned but missing):** `POST /api/desktop/runtime/archive-artifact` — accepts `{runId, artifactId, path, sha256, sizeBytes}`, accepts a staged path **only inside `archive-staging\<runId>\`**, **re-hashes it** (the `receiveShellPath` pattern at `backup.route.ts:184-231`), then enqueues the upload.
3. **Wire `scheduledRunEntry`** (`driveArchiveWiring.ts:29`) to the real implementation — the seam is already there and unfilled.
4. **Make `archiveBundle.ts` live:** give it a DB query so `decideRender` (`:42-50`) has production callers, and have the monthly pass use its `sourceHash` to skip unchanged documents.

**Safety & zero-regression invariants**
- The runtime route must verify that the submitted path is inside the expected staging root — **path traversal is the primary risk** and the existing `receiveShellPath` pattern is the reference.
- The re-hash must be recomputed server-side from the file; the client's `sha256` is a **claim**, not a fact.
- The backend must not trust the shell's `runId`/`artifactId` for authorisation.

**Exit verification** an end-to-end test: the backend queues a render request → the shell (simulated) returns an artifact → the backend re-hashes it → the upload is enqueued → the queue row reaches `done`.

---

#### **Task 3.10 — Platform-gate the module and dedupe the `windows` crate (E-09, E-10)**

**Scope** `desktop-app/src-tauri/Cargo.toml` · `main.rs` · `pdf_render.rs`
**Deterministic fix**
1. Gate the module: `#[cfg(windows)] mod pdf_render;` in `main.rs` with a `#[cfg(not(windows))]` stub for the command surface.
2. Align the `windows` dependency to `0.62` so the tree carries one version.

**Safety & zero-regression invariants** — the `webview2-com = "=0.39.1"` pin must be preserved (it matches what tauri links; one copy of `webview2-com` in the lock). Do **not** bump `webview2-com`.

**Exit verification** `cd desktop-app/src-tauri && cargo tree -d` shows no duplicate `windows`; `cargo test -j1` passes.

---

#### **Task 3.11 — Wire the frontend bridge (E-11)**

**Scope** `src/infrastructure/tauri-bridge.ts:198-234` · the caller of the render request
**Deterministic fix** Implement the caller that consumes the backend's render request, calls `archiveRenderPdf` / `archiveCapturePng`, and posts the result to `/api/desktop/runtime/archive-artifact`. Add `archiveClearRun` cleanup after a run completes.

**Safety & zero-regression invariants**
- The bridge functions must remain **no-ops outside Tauri** (`if (!isTauri()) return null;`).
- All three commands must be in `build.rs` **and** `capabilities/default.json` (Task 1.1) — the ACL test enforces this.

**Exit verification** a test that the bridge functions are called by the render consumer (mocked `invoke`).

---

#### **Task 3.12 — Make the snapshot route produce a complete document (E-12 cont.)**

**Scope** `src/routes/archive-snapshot.tsx`
**Deterministic fix** If Task 3.2 selects Option B, the route must render `wrapArchiveDocument(...)` (a full `<html>` with the Arabic font CSS), not a fragment, and must signal readiness to the renderer (e.g. `document.title` or a `data-archive-ready` attribute observed by the shell). If Option A, delete the route and its `routeTree.gen.ts` entry.

**Safety & zero-regression invariants** — the `data-archive-ready` attribute is the readiness handshake and must be preserved or replaced by an equivalent.

**Exit verification** `npx tsc --noEmit`; `git diff src/routeTree.gen.ts` shows the footer intact.

---

#### **Task 3.13 — Connect the remaining builders to production (E-13)**

**Scope** `src/components/print/archiveDocuments.ts` · the render consumer
**Deterministic fix** `buildInvoiceBody`, `buildStatementBody`, `orderStatementLegs`, `runningBalances`, and `wrapArchiveDocument` must each have **at least one production caller** in the render pipeline — for invoice, statement, and cashbox artefacts respectively.

**Safety & zero-regression invariants** — the 19 existing builder tests must pass unchanged; they are the specification for the rendered output.

**Exit verification** a production-import audit: `rg -n "buildInvoiceBody|buildStatementBody|wrapArchiveDocument" src/ --glob '!*__tests__*'` must return ≥1 hit each.

---

### 🛑 STAGE 3 EXIT GATE

```powershell
# Desktop
node --test desktop-app/scripts/ipc-acl.test.mjs          # MUST PASS
cd desktop-app && npm test && cd src-tauri && cargo test -j1 && cargo check --offline   # MUST PASS

# Types / lint / suites
npx tsc --noEmit && cd backend && npx tsc --noEmit        # MUST PASS
npm run lint && cd backend && npm run lint                # 0 warnings
npx vitest run && cd backend && DB_ENGINE=sqlite npx vitest run   # MUST PASS

# Schema
cd backend && npm run typecheck:sqlite                     # MUST PASS

# PROTOTYPE (physical desktop, not CI)
#  - A real PDF is produced from an Arabic invoice; page box == A4; glyphs correct
#  - A real PNG cashbox snapshot is produced at 2× scale
#  - The UI stays responsive during a 20-document render
#  - The produced PDF's SHA-256 matches the value reported to the backend
#  - The backend re-hash matches the shell's claim

# Protected files
git diff --numstat -- <the 9 protected files>              # MUST equal 42 ins / 27 del
```

**Stage 3 deliverable statement:** *the desktop produces real, correctly-sized, Arabic-shaped PDFs and PNG snapshots, off the UI thread, and the backend can actually drive and receive them.*

---

### STAGE 4 — RE-ARCHITECT PHASE 5 SMART MERGE

**Objective:** Replace the paper design with a design that respects the schema's **actual** invariants, then implement it.

**Entry condition:** Stages 1–3 exit gates green. **Hard prerequisites:** Task 2.14 (download capability) must be complete — the merge engine cannot read anything from Drive without it.

> **Design-first discipline.** Tasks 4.1–4.10 are **design and schema** tasks. **No merge-apply code is written until Task 4.10's exit gate is green.**

---

#### **Task 4.1 — Rewrite Phase 5's design against the real schema (G-01)**

**Scope** `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md` §5 (rewrite) · new `docs/MERGE_ENGINE_DESIGN.md`
**Deterministic fix** Produce a corrected design document that, for every replay target, states: **(a)** the actual storage model, **(b)** the correct algorithm, **(c)** the existing prior art to reuse, **(d)** the invariant that proves correctness. Explicitly retire: the party-balance replay (G-12), the naive cashbox replay (G-02), the ledger insert-without-identity (G-03), the pieces replay (G-05), and the D-7 flag-only policy (G-06).

**Safety & zero-regression invariants** — the design must remain consistent with `CLAUDE.md`'s two-engine rule and the money policy (`round2dp` / `roundDiv`, never `Math.round`).

---

#### **Task 4.2 — Remove party-balance replay from the design (G-12)**

**Scope** design only
**Deterministic fix** Party balances are **derived at read** (`SqliteLedgerRepository.ts:263-287`); the `party_balances` table was **dropped** (`0038_drop_party_balances.sql`). The design must therefore contain **no party-balance write**. I-1 becomes a cheap assertion (ledger sum == statement-reported balance), not a replay target.

**Safety & zero-regression invariants** — no code may write a party balance column; the column does not exist.

---

#### **Task 4.3 — Adopt `rebuildCashboxSeries` for the cashbox (G-02)** ⭐

**Scope** design + `backend/src/infrastructure/backup/merge/replay.ts` (new)
**Deterministic fix**
1. **Copy `rebuildCashboxSeries`** (`dyePurgeRepository.ts:390-445`) semantics exactly: `DELETE` the affected series, then re-derive with `sum(daily_delta) OVER (PARTITION BY currency ORDER BY day)`.
2. **Neutralise the `cashbox_daily_ledger_ai` trigger for the merge transaction** so the trigger's shift and the rebuild do not both apply. Follow the existing `motard_tx_state` flag pattern (`allow_dye_purge`, `allow_party_remap`) — add an `allow_series_rebuild` flag, set and cleared transactionally.
3. The rebuild must cover **all** dates from the first affected date to the present, **not** a suffix from the merge point.

**Safety & zero-regression invariants**
- The `cashbox_daily_ledger_ai`/`_au`/`cashbox_daily_manual_aiud` triggers must be **unchanged** in the schema.
- The rebuild must reproduce the **identical** series when nothing was imported — this is the property that proves the algorithm.
- Money arithmetic must use `round2dp` / `roundDiv`, never SQLite's `round()`.

**Exit verification** a test: rebuild with zero imported rows → every `closing_balance` is **byte-identical** to the pre-merge series.

---

#### **Task 4.4 — Give the ledger a deterministic identity (G-03)** ⭐

**Scope** `ledger-entry.table.ts` (PG + SQLite schemas) · PG migration · SQLite migration · `0000_baseline.sql` regeneration · fingerprint regeneration
**Deterministic fix** Add an identity column to `ledger_entries` — e.g. `source_system TEXT` + `source_id TEXT` — with a unique index, **or** mandate a deterministic `client_operation_id` for every merged row. A merged row's identity must be a **pure function of the source row**, so re-running a merge is idempotent.

**This is a business-table change ⇒ PG migration + PG twin + SQLite baseline regeneration are mandatory per `CLAUDE.md`.**

**Safety & zero-regression invariants**
- The append-only trigger (`trg_ledger_entries_append_only`) must remain **unchanged**.
- Existing rows must be backfilled with a null/legacy identity; the unique index must be **partial** (`WHERE … IS NOT NULL`) so legacy rows do not collide.
- The PG and SQLite twins must stay behaviourally identical (`PORTED-FROM … sha256=` header).

**Exit verification** a test: merging the same backup twice → the second merge inserts **zero** ledger rows (idempotent).

---

#### **Task 4.5 — Extend `stock_movements` with identity and pieces (G-04, G-05, G-13)** ⭐

**Scope** `stock-movement.table.ts` (PG + SQLite) · PG migration · SQLite migration · baseline + fingerprint
**Deterministic fix** Add `client_operation_id` (partial unique, matching the pattern of `invoices`/`ledger_entries`/`returns`/`vouchers`) and `pieces_delta INTEGER NOT NULL DEFAULT 0`. Only then can `remaining_pieces` be replayed.

**Safety & zero-regression invariants**
- `stock_movements` has **no FK to invoices** (only to `rolls`) — this must not change.
- Existing rows backfill with null identity; the unique index is partial.
- The `stock_movements` ↔ `rolls.remaining_kg` atomicity invariant must be preserved: movement + counter in **one** transaction.

**Exit verification** a test: with the extension in place, a merge can reconstruct `remaining_pieces` exactly.

---

#### **Task 4.6 — Downgrade I-3 and never replay `paid` (G-08, B-05)**

**Scope** design + `mergeApply.ts`
**Deterministic fix** `invoices.paid` is app-owned and drifts by construction. The merge must **not** write it. I-3 becomes a **diagnostic** (`|paid − Σ applied| ≤ tolerance`) reported in the merge report, not a gate.

**Safety & zero-regression invariants** — `paid` must be byte-identical before and after a merge for every invoice the merge did not explicitly touch.

---

#### **Task 4.7 — Make D-7 a real renumbering plan (G-06)**

**Scope** `mergePlanner.ts` (new) · the staged copy
**Deterministic fix** Detect `(tenant, type, number)` collisions against the live DB **in the planner**. For each collision: propose a **new number** that does not collide, rewrite `number` **and** `reference_number` in the **staged copy** (never in the live DB), and record the mapping in the merge report for human review.

**Safety & zero-regression invariants**
- The live DB is never written during planning.
- The proposed number must respect the numbering convention and must not collide with any live row.
- The staged copy is disposable and re-derived from the ZIP on every plan.

---

#### **Task 4.8 — Pre-apply refusal for closed periods (G-07)**

**Scope** `mergePlanner.ts` · `mergeApply.ts`
**Deterministic fix** The planner must **refuse** any period intersecting a `day_closes` date or a `closed` `financial_years` year, and the applier must **re-check inside the transaction** before any write. The refusal is a **pre-apply gate**, not a post-hoc flag.

**Safety & zero-regression invariants** — `day_closes` and `financial_years` rows are **never** modified by a merge.

---

#### **Task 4.9 — Add the missing cross-invariants (G-09, G-10)**

**Scope** design + `mergeApply.ts`
**Deterministic fix** Add to the invariant set:
- **I-10** — per imported invoice: `Σ(active ledger legs) == header total`, per currency, 2dp.
- **I-11** — per imported invoice: `Σ(stock_movements) == Σ(invoice_lines)` for kg **and** pieces.
- **I-12** — `invoices.paid` diagnostic (see Task 4.6).
- **I-13** — no imported row intersects a closed day/year (see Task 4.8).
- **I-14** — the rebuilt cashbox series equals the pre-merge series for **every date after** the merge point (a proof the rebuild is a no-op outside the imported window).
- **I-15** — for every roll touched: `0 ≤ remaining_kg ≤ initial_kg` and `remaining_pieces ≥ 0`.

**And constrain the apply step:** replacing an invoice's lines **must** either (a) replay the corresponding `stock_movements` in the same transaction, or (b) be **refused** by the planner (insert-only merges for stock-bearing documents).

**Safety & zero-regression invariants** — I-10 is the central double-entry invariant and must be evaluated per invoice, per currency, never in aggregate (aggregate sums hide per-document errors).

---

#### **Task 4.10 — Specify and test the hub interaction (G-11)**

**Scope** design + `backend/src/infrastructure/integrity/hubFingerprint.ts:100-117`
**Deterministic fix** Define how merged rows propagate to the cloud hub:
1. Merged rows carry a deterministic `client_operation_id` so the hub's replay is idempotent.
2. After a merge, `takeHubFingerprint` equality must be re-established — the fingerprint covers `SUM(debit)-SUM(credit)` per party/currency and `rolls.remaining_kg`/`remaining_pieces` (`hubFingerprint.ts:100-117`), which is precisely what the merge changes.
3. Specify the conflict rule when the hub has newer data for a merged document.

**Exit verification** a test: merge → the hub fingerprint of the merged tenant equals the fingerprint recomputed from the merged local DB.

---

#### **Task 4.11 — Implement the merge engine, in four isolated increments**

| Increment | Deliverable | Files | Gate |
|---|---|---|---|
| **4.11a** | **Catalogue + download + integrity** (Phase 5a/5b/5c) | `motard_backup_catalog` migration · `driveDownload.ts` · `GET /api/drive/backups` | The last 10 backups list; a downloaded ZIP verifies against its manifest and SHA-256. |
| **4.11b** | **Planner** (Phase 5e) — **pure, read-only** | `mergeStage.ts` · `mergePlanner.ts` | Golden fixtures (§4.11d) pass. The live DB is provably untouched (`PRAGMA data_version` unchanged). |
| **4.11c** | **Applier** (Phase 5f) — **the dangerous part** | `mergeApply.ts` · `replay.ts` | All of I-1…I-15 pass. A failure injection after every step leaves the DB **byte-identical**. |
| **4.11d** | **UI** (Phase 5i) | `MergeRestoreDialog.tsx` · `BackupHistoryTable.tsx` · `src/lib/drive-backups.ts` | The plan summary shows the real counts; conflicts are per-row, not per-table. |

**Safety & zero-regression invariants for the whole stage**
- **The live database is never written during planning.** Enforce it with a **read-only connection** to the staged copy (`{readonly: true}`) and a `PRAGMA query_only` on the live connection during planning.
- The apply step runs in a **single** `BEGIN IMMEDIATE` transaction with **all-or-nothing** semantics; any invariant failure → `ROLLBACK` → `MERGE_VERIFY_FAILED`.
- A **safety backup** (`createAndVerifyBackup({kind:"pre-operation"})`) is taken **before** the transaction.
- The apply endpoint requires an `Idempotency-Key` and is **admin-only** (`rbac(["admin"])`).
- A stale plan is refused: compare a live digest recorded at plan time → `PLAN_STALE`.
- The wholesale replace path (`POST /api/backup/restore`) is **untouched** and must behave exactly as before.

---

#### **Task 4.12 — Implement the golden-fixture and property test suite (Phase 5j)**

**Scope** `backend/tests/merge/` (new)
**Deterministic fix**
1. **Golden fixtures:** two seeded SQLite databases — a backup at day 10 with invoices 1–20; a live DB with invoices 1–30, one invoice cancelled in live, one edited in the backup. Assert after merge: 30 invoices present; the cancelled one stays cancelled; the edited one takes the higher version; **every** invariant I-1…I-15 passes; party balances equal a from-scratch replay of all ledger legs; the cashbox series equals a from-scratch rebuild.
2. **Order-independence property:** `merge(A,B)` and `merge(B,A)` produce identical final balances and invoice sets.
3. **Idempotency property:** `merge(A,B)` twice → the second is a no-op.
4. **Failure injection:** crash after every step → the database is unchanged.
5. **Regression:** `backup-restore-cycle.test.ts` and `backup-restore-roundtrip.test.ts` must still pass (the wholesale path is untouched).

---

### 🛑 STAGE 4 EXIT GATE

```powershell
# Desktop + contract
node --test desktop-app/scripts/ipc-acl.test.mjs          # MUST PASS
cd desktop-app && npm test && cd src-tauri && cargo test -j1    # MUST PASS

# Types / lint
npx tsc --noEmit && cd backend && npx tsc --noEmit         # MUST PASS
npm run lint && cd backend && npm run lint                 # 0 warnings

# Schema — BUSINESS TABLES CHANGED (ledger_entries, stock_movements)
cd backend && npm run typecheck:sqlite                     # MUST PASS (schema + fingerprint)
cd backend && npm run db:check                             # MUST PASS

# Suites
npx vitest run                                            # MUST PASS
cd backend && DB_ENGINE=sqlite npx vitest run             # MUST PASS
cd backend && npx vitest run tests/merge/                 # ALL merge suites MUST PASS

# Wholesale restore untouched
cd backend && npx vitest run tests/backup-restore-cycle.test.ts `
  tests/sqlite/restore-roundtrip.test.ts                   # MUST PASS

# Drift reconciler — post-merge the database must be clean
node backend/scripts/reconcile-integrity-sqlite.mjs --db <merged.db>
#  → stock_vs_movements: 0, orphan_ledger_party: 0, sync_dead: 0, exit 0

# Ledger integrity
node scripts/ledger-integrity-check.mjs                    # MUST PASS

# Protected files
git diff --numstat -- <the 9 protected files>              # MUST equal 42 ins / 27 del
```

**Stage 4 deliverable statement:** *merging an older archive into a live database adds only the missing history, keeps every newer record, passes all fifteen invariants, leaves the cashbox series provably identical outside the imported window, and cannot double-post — while the wholesale restore behaves exactly as before.*

---

## §3 — MULTI-LAYER VERIFICATION & CROSS-AUDIT PROTOCOL

### 3.1 The Three Gates

```
   ┌──────────────────────────────────────────────────────────────┐
   │  GATE A — AUTOMATED (CI, every commit)                     │
   │  Contract · Types · Lint · Unit · Integration · Schema      │
   └───────────────────────────┬──────────────────────────────────┘
                               │  all green
   ┌───────────────────────────▼──────────────────────────────────┐
   │  GATE B — SEMANTIC (schema, invariants, drift)              │
   │  Triggers · FK · Double-entry · Fingerprint · Reconciler    │
   └───────────────────────────┬──────────────────────────────────┘
                               │  all green
   ┌───────────────────────────▼──────────────────────────────────┐
   │  GATE C — TACTICAL (physical desktop, manual, witnessed)    │
   │  PDF/PNG · UI responsiveness · Drive behaviour · Merge      │
   └──────────────────────────────────────────────────────────────┘
```

**Gate C cannot be replaced by Gate A.** The PDF/PNG engine (Stage 3) and the merge applier (Stage 4) are both unverifiable on CI — one requires a real WebView2 runtime, the other requires a human to inspect a rendered financial document.

### 3.2 Layer 1 — Unit & Integration

| Suite | Command | Frequency | Gate |
|---|---|---|---|
| Rust unit | `cd desktop-app/src-tauri && cargo test -j1` | every commit | A |
| Rust compile | `cd desktop-app/src-tauri && cargo check --offline` | every commit | A |
| Desktop scripts | `cd desktop-app && npm test` | every commit | A |
| **IPC parity** | `node --test desktop-app/scripts/ipc-acl.test.mjs` | every commit | **A — hard** |
| Frontend + shared | `npx vitest run` | every commit | A |
| Backend (SQLite) | `cd backend && DB_ENGINE=sqlite npx vitest run` | every commit | A |
| Backend (Postgres) | `cd backend && npm run test` | nightly | A |
| Frontend typecheck | `npx tsc --noEmit` | every commit | A |
| Backend typecheck | `cd backend && npx tsc --noEmit` | every commit | A |
| Lint (0 warnings) | `npm run lint` · `cd backend && npm run lint` | every commit | A |

> **`CLAUDE.md:33`:** *"Never use `vitest --reporter=basic`: it can exit 0 having run nothing. Read the summary line."* Every CI run must assert on the **summary line**, not the exit code alone.

### 3.3 Layer 2 — Schema & Invariants

| Check | Command / Method | Asserts |
|---|---|---|
| Schema + fingerprint drift | `cd backend && npm run typecheck:sqlite` | The committed SQLite schema matches the Drizzle schemas, and `meta/schema-fingerprint.json` matches the migrations. |
| Drizzle consistency | `cd backend && npm run db:check` | No pending migration drift. |
| Migration applicability | `cd backend && npm run db:migrate` on a seeded DB | `0007` (and any later migration) applies cleanly and preserves every row. |
| Trigger inventory | `SELECT name FROM sqlite_master WHERE type='trigger'` | The append-only, cashbox, licence-audit, and sync triggers are **present and unchanged**. A missing trigger is a silent invariant loss. |
| Foreign-key integrity | `PRAGMA foreign_key_check` | Empty. (Plan invariant I-5.) |
| Structural integrity | `PRAGMA integrity_check` | `ok`. (Plan invariant I-9.) |
| Append-only enforcement | Insert/update/delete probes on `ledger_entries` | UPDATE and DELETE are rejected; the `allow_party_remap` and `allow_dye_purge` escape hatches behave exactly as before. |
| Cashbox trigger semantics | Insert a probe ledger row on a known date | The delta applies to that day **and shifts all later days** — confirming the G-02 analysis and the Task 4.3 rebuild requirement. |
| Stock audit trail | `backend/scripts/reconcile-integrity-sqlite.mjs` | `stock_vs_movements = 0` — `rolls.remaining_kg` equals the last `stock_movements.balance_after_kg`. |
| Ledger integrity | `node scripts/ledger-integrity-check.mjs` | No active entry carries both debit and credit; the DB party sums match the statement endpoint's balances. |
| Orphan detection | `reconcile-integrity-sqlite.mjs` | `orphan_ledger_party = 0`. |
| Double-entry (merge) | the new merge invariant suite | I-1…I-15, evaluated **per invoice and per currency**. |
| Hub fingerprint | `backend/scripts/compare-hub-fingerprints.mjs` | The merged local DB's fingerprint equals the hub's for the affected tenant. |
| Backups unaffected | `backend/tests/sqlite/backup-roundtrip.test.ts` | The `motard_drive_*` and `motard_merge_*` tables remain excluded from backups. |

### 3.4 Layer 3 — Regression Check: the Protected File Set

**Invariant:** the 9 protected files must remain at the **measured** baseline of **42 insertions / 27 deletions** (§0.2).

```powershell
$protected = @(
  'src/components/invoices/SaleLineCard.tsx',
  'src/components/invoices/entry-types.ts',
  'src/components/invoices/sale-types.ts',
  'src/components/parties/PartyTable.tsx',
  'src/routes/invoices.entry.new.tsx',
  'src/routes/invoices.sale.new.tsx',
  'src/routes/cashbox.tsx',
  'src/components/print/blankFirstPage.test.ts',
  'src/shared/utils/documentArchive.ts'
)
git diff --numstat -- $protected
```

**Expected (verbatim):**
```
5	6	src/components/invoices/SaleLineCard.tsx
2	1	src/components/invoices/entry-types.ts
2	1	src/components/invoices/sale-types.ts
10	7	src/components/parties/PartyTable.tsx
7	1	src/components/print/blankFirstPage.test.ts
3	1	src/routes/cashbox.tsx
5	4	src/routes/invoices.entry.new.tsx
6	6	src/routes/invoices.sale.new.tsx
2	0	src/shared/utils/documentArchive.ts
```
**Totals: 42 insertions, 27 deletions.**

**Escalation rule:** if any Stage alters this set beyond the single documented exception (Task 1.7 may require an additive change to `documentArchive.ts` if a 7th category is added), the deviation must be:
1. Explicitly recorded in the stage's exit report,
2. Justified with a functional reason, and
3. Re-baselined in §0.2 of this document **in the same commit**.

**Content-level confirmation** — the numstat proves *how much* changed, not *what*. The protected set must also be **content-verified**:
- `SaleLineCard.tsx`, `entry-types.ts`, `sale-types.ts`, `invoices.entry.new.tsx`, `invoices.sale.new.tsx` → the "ISSUE 3" pieces-default change (`pieces: 1` → `pieces: 0` and the `?? 0` guards) must be intact and functional.
- `PartyTable.tsx` → the single-line per-currency totals layout must be intact.
- `cashbox.tsx` → the explicit `(prev: CashboxPeriodFilter & { tab?: string })` type annotation must be intact.
- `documentArchive.ts` → the business-month `period` threading must be intact.
- `blankFirstPage.test.ts` → the DFP-002 guard must still assert the **import and call** of `archivePageCss` (not a literal string).

**Beyond the file set** — the *behavioural* protections that no diff can capture:
```powershell
npx vitest run src/components/print/ src/components/invoices/ src/components/parties/
```
These must pass at every stage gate. A behaviour regression in the protected files is worse than a numstat delta.

### 3.5 Layer 4 — Tactical / Physical-Desktop Verification (Gate C)

| # | Scenario | Pass criterion | Witnessed by |
|---|---|---|---|
| T-1 | Render an Arabic sale invoice to PDF | Page box == A4 (595.28 × 841.89 pt); glyphs correct; no tofu; totals match the invoice | Screenshot + PDF |
| T-2 | Render an A5 statement | Page box == A5; pagination correct | Screenshot + PDF |
| T-3 | Render a cashbox PNG snapshot | 2× scale; per-currency; **no cross-currency addition**; outflows non-zero (the B-04 regression guard) | PNG |
| T-4 | Render 20 documents back-to-back | The window **stays responsive** throughout (the E-05 guard) | Screen recording |
| T-5 | Upload → edit the invoice → re-upload | **Exactly one** Drive file; same file id; updated content; updated name (the C-01/C-04 guard) | Drive UI + API |
| T-6 | Rename the party → re-upload | **Exactly one** Drive file (the C-01 guard) | Drive UI |
| T-7 | Cancel the invoice → re-upload | **Exactly one** Drive file (the C-01 guard) | Drive UI |
| T-8 | Cancel a run mid-flight | HTTP 2xx; the run row reads `cancelled`, **not** `failed` (the B-01 guard) | DB query + UI |
| T-9 | Two archive triggers at once | One performs work; the other reports a distinguishable `BUSY` (the C-07 guard) | Logs |
| T-10 | Archive with the network unplugged mid-batch | The job backs off and retries; the token refresh works; no permanent `blocked` (the C-09/C-10 guard) | Logs |
| T-11 | Month end with the app closed | On the next launch, the archive runs **once**, for the **closed** period, with full catch-up (the D-04/D-05/D-16 guards) | DB rows + Drive |
| T-12 | Merge an older backup into a newer live DB | 30 invoices present; the cancelled one stays cancelled; **all I-1…I-15 pass**; the cashbox series is identical outside the imported window; party balances match a from-scratch replay | Merge report + `reconcile-integrity-sqlite.mjs` |
| T-13 | Merge the same backup twice | The second merge inserts **zero** rows (the G-03 idempotency guard) | DB row counts |
| T-14 | Merge with an existing `day_closes` in the range | **Refused pre-apply**, with a clear message (the G-07 guard) | UI + logs |
| T-15 | Merge with a colliding invoice number | The invoice is imported under a **proposed new number**, flagged for review (the G-06 guard) | Merge report |
| T-16 | Merge with the hub enabled | The hub fingerprint matches after the merge (the G-11 guard) | `compare-hub-fingerprints.mjs` |

### 3.6 Cross-Audit Protocol — Post-Fix Verification

**The remediation must be audited by a party that did not perform it.** The same conditions that produced the 45/100 finding — self-reported status, unverified claims — are the failure mode to guard against.

#### **3.6.1 — Evidence rules**

1. **Every claim must cite a command and its output.** A claim of the form "this now works" without a transcript is **not evidence**.
2. **Read the summary line, not the exit code** (`CLAUDE.md:33`).
3. **A test that was never executed does not exist.** Every new test must have a **recorded run** in the stage exit report.
4. **Negative results must be reported.** A skipped, flaky, or quarantined test is a **finding**, not a footnote.
5. **The stage exit report must include the full diff stat** for the stage, so the next auditor can see the blast radius.

#### **3.6.2 — Post-fix audit checklist (run at the end of every stage)**

```
☐  git status — every change is committed with a message that states the problem it closes
☐  git diff --stat <base>..HEAD — the blast radius is proportional to the stage
☐  The IPC parity test passes (the check that opened this audit)
☐  Every new/changed test has a recorded execution transcript
☐  The protected-file numstat equals 42/27 (or a documented, justified deviation)
☐  No "TODO", "FIXME", or "not implemented" string was introduced without a linked issue ID
☐  No documentation asserts a capability that the code does not provide  ← the E-02/H-01 class of defect
☐  No plan document cites a route, table, or function that does not exist  ← the H-04 class of defect
☐  Every DB CHECK constraint agrees with its TypeScript union  ← the B-01 class of defect
☐  Every registered Tauri command is in build.rs AND capabilities  ← the A-01 class of defect
☐  Every frontend bridge function has ≥1 production caller  ← the E-11 class of defect
☐  Every new exported function has ≥1 production caller OR is explicitly marked test-only
☐  Schema fingerprint regenerated and committed
☐  PG/SQLite twins both updated, with the PORTED-FROM sha256 refreshed
☐  The stage's exit gate was executed IN FULL and every command's output recorded
```

#### **3.6.3 — Anti-patterns this protocol exists to catch**

These are the exact defects the audit found. Each maps to a checklist line:

| Anti-pattern | Instance found | Checklist line |
|---|---|---|
| Registering an IPC command without declaring it | A-01, A-02 | "Every registered Tauri command is in build.rs AND capabilities" |
| A TS union that outruns its DB CHECK | B-01 | "Every DB CHECK constraint agrees with its TypeScript union" |
| Documentation claiming a capability the code lacks | E-02, H-01, H-04 | "No documentation asserts a capability the code does not provide" |
| A plan citing a route that does not exist | H-04 | "No plan document cites a route, table, or function that does not exist" |
| A bridge function with no caller | E-11 | "Every frontend bridge function has ≥1 production caller" |
| A helper used only by tests | E-13, `archiveBundle.ts` | "Every new exported function has ≥1 production caller OR is explicitly marked test-only" |
| A test fake that never exercises the branch it exists for | C-06 | "Every new test has a recorded execution transcript" + the Task 2.5 gate |
| A migration promised but never written | B-02, I-04 | "Schema fingerprint regenerated and committed" + the Drizzle check |
| A guard implemented as a flag with an `await` in the middle | C-07 | "git diff --stat … the blast radius is proportional to the stage" + the Task 2.7 concurrency test |
| A scheduler designed in two places, only one wired | D-01, D-03 | "Every new exported function has ≥1 production caller" |
| A replay designed without checking the storage model | G-02, G-05, G-12 | "Every DB CHECK constraint agrees…" generalised: *verify the storage model before designing the write* |

### 3.7 Issue → Stage Traceability Matrix

| Issue | Sev | S1 | S2 | S3 | S4 | Primary verification |
|---|:--:|:--:|:--:|:--:|:--:|---|
| A-01 ACL manifest | S1 | ● | | | | `ipc-acl.test.mjs` |
| A-02 capability list | S1 | ● | | | | `ipc-acl.test.mjs` |
| A-03 hidden window caps | S2 | | ● | | | `ipc-acl.test.mjs` + manual render |
| A-04 routeTree footer | S3 | | | ● | | `tsc` + generator diff |
| B-01 cancelled CHECK | S1 | ● | | | | migration test + T-8 |
| B-02 missing run columns | S2 | | ● | | | `typecheck:sqlite` |
| B-03 dead `revision` | S4 | | | | ● | `typecheck:sqlite` |
| B-04 cashOut zeroing | S2 | | ● | | | unit test + T-3 |
| B-05 `paid` drift | S3/S1 | | ● | ● | | I-12 diagnostic + T-12 |
| C-01 filename key | S1 | ● | | | | Task 2.5 test + T-5/6/7 |
| C-02 discarded id | S3 | | | ● | | Task 2.1 test |
| C-03 parent-scoped lookup | S2 | | ● | | | Task 2.3 test |
| C-04 name not updated | S2 | | ● | | | Task 2.4 test + T-5 |
| C-05 `"archive"` tenant | S2 | | ● | | | Task 2.2 test |
| C-06 untested upsert | S2 | | ● | | | **Task 2.5** |
| C-07 `passInFlight` race | S2 | | ● | | | Task 2.7 concurrency test |
| C-08 swallowed skip | S3 | | | ● | | route test |
| C-09 no 401 refresh | S2 | | ● | | | 401 test + T-10 |
| C-10 no timeouts | S2 | | ● | | | timeout test |
| C-11 session-init retry | S3 | | | ● | | drive tests |
| C-12 existence-only verify | S2 | | ● | | | hash-mismatch test |
| C-13 no download | S1 | ● | | | | Task 2.14 round-trip test |
| D-01 dead scheduler | S2 | | ● | | | `rg` static proof |
| D-02 24×6h rescan | S2 | | ● | | | "second tick does zero work" test |
| D-03 dual scheduler | S3 | | | ● | | `rg` static proof |
| D-04 month-end timing | S2 | | ● | | | decision-table test + T-11 |
| D-05 one-month catch-up | S2 | | ● | | | decision-table test + T-11 |
| D-06 body ignored | S2 | | ● | | | route test |
| D-07 blocking 202 | S2 | | ● | | | "<100 ms" test |
| D-08 no `runId` | S2 | | ● | | | route test |
| D-09 in-memory progress | S2 | | ● | | | restart test |
| D-10 hard-coded `kind` | S3 | | | ● | | route test |
| D-11 `scheduledRunEntry` | S3 | | | ● | | Task 3.9 |
| **D-12 cancel flag clobbered** | **S1** | ● | | | | **`drive-run-cancel.test.ts` + the pass must not throw** |
| E-01 render stub | S1 | ● | | | | T-1/T-2 + real PDF |
| E-02 false module doc | S3 | | | ● | | checklist review |
| E-03 dead `Paper::inches` | S3 | | | ● | | page-box test |
| E-04 sleep vs. readiness | S2 | | ● | | | cold-font render |
| E-05 UI-thread block | S2 | | ● | | | T-4 |
| E-06 `ICoreWebView2_7` | S2 | | ● | | | compile + T-1 |
| E-07 `IStream` | S2 | | ● | | | compile + T-3 |
| E-08 `PWSTR` leak | S4 | | | | ● | memory check |
| E-09 `cfg(windows)` | S4 | | | | ● | `cargo tree` |
| E-10 dual `windows` crate | S4 | | | | ● | `cargo tree -d` |
| E-11 no frontend caller | S2 | | ● | | | production-import audit |
| E-12 contract mismatch | S2 | | ● | | | Task 3.2 test |
| E-13 test-only builders | S3 | | | ● | | production-import audit |
| E-14 render-request hole | S1 | ● | | | | Task 3.9 end-to-end test |
| F-01 print_send regression | S1 | ● | | | | Rust parity test |
| F-02 missing `period` | S3 | | | ● | | print tests |
| F-03 root name divergence | S3 | | | ● | | Rust naming test |
| F-04 one-way parity test | S4 | | | | ● | strengthened test |
| G-01 merge unimplemented | S1 | ● | | | | Task 4.11d |
| G-02 cashbox double-count | S1 | ● | | | | rebuild-equality test + T-12 |
| G-03 no ledger identity | S1 | ● | | | | idempotency test + T-13 |
| G-04 `stock_movements` gaps | S1 | ● | | | | Task 4.5 test |
| G-05 pieces unreconstructable | S1 | ● | | | | Task 4.5 test |
| G-06 D-7 unimplementable | S2 | | ● | | | T-15 |
| G-07 late closed-period flag | S2 | | ● | | | T-14 |
| G-08 I-3 already false | S2 | | ● | | | I-12 diagnostic |
| G-09 missing cross-invariant | S1 | ● | | | | I-10 + T-12 |
| G-10 stock desync on edit | S1 | ● | | | | I-11 + T-12 |
| G-11 hub ignored | S2 | | ● | | | fingerprint test |
| G-12 unnecessary replay | S4 | | | | ● | design review |
| G-13 omitted movements | S2 | | ● | | | Task 4.5 test |
| H-01 false module doc | S3 | | | ● | | Stage 1 T1.5 |
| H-02 false "only this route" | S3 | | | ● | | Stage 1 T1.6 |
| H-03 G-8 misreported | S2 | | ● | | | Stage 2 T2.16 |
| H-04 phantom route | S2 | | ● | | | Stage 3 T3.9 |
| H-05 bidirectional hole | S2 | | ● | | | Stage 3 T3.9 |
| I-01 uncommitted tree | S2 | | ● | | | Task 1.0 |
| I-02 scope interleaving | S3 | | | ● | | Task 1.0 |
| I-03 cached roll write | S2 | | ● | | | Task 1.0 (isolated commit) |
| I-04 no migration discipline | S2 | | ● | | | `typecheck:sqlite` every stage |
| **I-05 sync coverage gap** | **S2** | | ● | | | **`tests/sync-coverage.test.ts` MUST PASS** |

### 3.8 Continuous Verification — Post-Stage Checklist (Single Command Block)

To be executed **verbatim** at the end of every stage, with all output captured:

```powershell
# ── CONTRACT ─────────────────────────────────────────────────────────
node --test desktop-app/scripts/ipc-acl.test.mjs
cd desktop-app; npm test; cd src-tauri; cargo test -j1; cargo check --offline

# ── TYPES + LINT ─────────────────────────────────────────────────────
cd <root>; npx tsc --noEmit
cd backend; npx tsc --noEmit
cd <root>; npm run lint
cd backend; npm run lint

# ── SCHEMA ───────────────────────────────────────────────────────────
cd backend; npm run typecheck:sqlite
cd backend; npm run db:check

# ── SUITES ───────────────────────────────────────────────────────────
cd <root>; npx vitest run
cd backend; DB_ENGINE=sqlite npx vitest run

# ── DRIFT (read-only, on a scratch DB) ──────────────────────────────
node backend/scripts/reconcile-integrity-sqlite.mjs --db <scratch.db>
node scripts/ledger-integrity-check.mjs

# ── PROTECTED FILES ──────────────────────────────────────────────────
git diff --numstat -- <the 9 protected files>   # MUST equal 42 ins / 27 del

# ── NO NEW DEAD CODE / FALSE CLAIMS ─────────────────────────────────
rg -n "TODO|FIXME|not implemented" --glob '!node_modules' src backend desktop-app/src-tauri/src
rg -n "archive_render_pdf_cmd|archive_capture_png_cmd|archive_clear_run_cmd" `
  desktop-app/src-tauri/build.rs desktop-app/src-tauri/capabilities/default.json
```

---

## §4 — APPENDIX

### 4.1 Evidence Index — Every Finding's Primary Source

| Finding group | Primary evidence |
|---|---|
| A (ACL/permissions) | `main.rs:50-52` · `build.rs:6-25` · `capabilities/default.json:6-26` · `ipc-acl.test.mjs:44-47` · **executed**: `node --test desktop-app/scripts/ipc-acl.test.mjs` → **FAIL** |
| B (schema) | `0005_drive_archive.sql:74-77` · `archiveRuns.ts:11,57-58` · `monthlyArchiveJob.ts:254-268` · `exporters.ts:83` |
| C (identity/network) | `uploadQueue.ts:74-86, 111-136, 266-276` · `driveClient.ts:132-196, 286-343` · `monthlyArchiveJob.ts:134-187` · `driveArchiveWiring.ts:29,58-61` |
| D (scheduling) | `monthlyArchiveJob.ts:50-51, 157-187, 297-308` · `archive_scheduler.rs:63-103` · `drive.route.ts:202-239` · `archiveRuns.ts:82-119` |
| E (renderer) | `pdf_render.rs:1-12, 40-45, 121-210` · `commands.rs:261-287` · `tauri-bridge.ts:198-234` · `webview2-com-sys-0.39.1/src/bindings.rs:1376-1395, 43636-43657` |
| F (local archive) | `commands.rs:145-154, 174-177, 438-447` · `tauri-bridge.ts:129` · `printPortal.ts:224` |
| G (merge design) | `PLAN.md:157, 477-494` · `0000_baseline.sql:479, 944, 1102-1129, 1460, 1544, 1666-1711` · `dayLockHelper.ts:26-80` · `dyePurgeRepository.ts:390-445` · `cashboxBalanceHelper.ts:17-140` · `0038_drop_party_balances.sql` |
| H/I (docs/process) | `PLAN.md:22, 301, 386` · `desktopRuntime.route.ts:32,60,84` · `git status` / `git diff --numstat` |

### 4.2 Baseline Measurements (reproducible)

```
Working tree at ec8dde8a (verified with `git status --porcelain -uall`):
  modified: 37 files        untracked: 17 files        total: 54 entries        committed: 0

git diff --numstat totals (all):
  backend/        +1,242  /  −204
  src/ (14 files)    +212  /  −162
  protected 9 files   +42   /  −27

Executed during the audit:
  node --test desktop-app/scripts/ipc-acl.test.mjs     → FAIL (exit 1)   ← A-01/A-02
  cd backend && npx vitest run <8 drive files>        → 79/79 PASS
  npx vitest run <3 new frontend/shared files>        → 53/53 PASS
  cd desktop-app/src-tauri && cargo check --offline   → PASS, 8 warnings (2 "never used")
```

> This masterfile itself adds one entry (`docs/REMEDIATION_AND_CORRECTION_PLAN.md`), taking the working tree to 37 modified + 18 untracked. **No application source file was modified in producing it.**

### 4.3 Definitions Used

| Term | Meaning in this document |
|---|---|
| **ACL** | Tauri 2's application command allow-list. A command absent from `build.rs` `APP_COMMANDS` **and** `capabilities/default.json` is refused at runtime. |
| **Stage gate** | The exact command block that must be green before the next stage begins. |
| **Tier P / Tier A** | Protected file tiers (§0.2). Tier P = business logic; Tier A = archive-adjacent. |
| **Blind double-count** | A financial figure applied twice — once by a DB trigger and once by a replay — producing silent drift with no error. |
| **Unanchored ledger row** | A `ledger_entries` row with no deterministic business identity, so re-insertion double-posts with no constraint violation. |
| **Reconstructable** | A derived value that can be recomputed from an existing audit trail. `remaining_kg` **is** (from `stock_movements`); `remaining_pieces` **is not**. |
| **Prior art** | An existing implementation in this codebase that solves the same problem and should be reused rather than reinvented (`rebuildCashboxSeries`, `uploadQueue.claim()`, `receiveShellPath`, `round2dp`/`roundDiv`). |

### 4.4 Definition of Done — The Whole Programme

The programme is complete when **all** of the following hold:

1. `node --test desktop-app/scripts/ipc-acl.test.mjs` passes — and has never regressed since.
2. Every DB `CHECK` constraint agrees with its TypeScript union.
3. Every registered Tauri command appears in `build.rs` **and** `capabilities/default.json`.
4. Every frontend bridge function has ≥1 production caller.
5. Every plan/design document cites only routes, tables, and functions that exist.
6. A PDF is produced by the desktop from a real Arabic invoice, at the right page size, off the UI thread.
7. The monthly archive runs **once per closed period**, with full multi-month catch-up.
8. An edited, renamed, cancelled, or renumbered invoice produces **exactly one** Drive file.
9. A merge adds only missing history, keeps every newer record, passes I-1…I-15, and provably cannot double-post.
10. `reconcile-integrity-sqlite.mjs` reports **zero** drift on a merged database.
11. The protected 9 files remain at **42 ins / 27 del**, content-verified.
12. An **independent** auditor re-runs this document's gates and agrees the score has materially improved.

---


---

## §5 — STAGE 1 EXECUTION RECORD

**Executed:** 2026-10-20 · **Baseline:** `ec8dde8a` + the uncommitted working tree
**Result: STAGE 1 EXIT GATE PASSED — the repository is green.**

### 5.1 Tasks completed

| Task | Outcome | Files changed |
|---|---|---|
| **1.0** (commit isolation) | **NOT DONE — deliberately deferred.** The directive scopes Stage 1 to the 8 remediation tasks; committing 40+ files of unrelated work (including the previous agent's) is a separate, owner-level decision. The tree is still uncommitted. | — |
| **1.1** ACL & manifest parity | **DONE.** The three archive commands are declared in `build.rs` `APP_COMMANDS` and granted in `capabilities/default.json`. `tauri_build` auto-generated the three `permissions/autogenerated/archive_*_cmd.toml`. A **separate** capability `capabilities/archive-render.json` grants the hidden `archive-render-*` window label a minimal set (`core:default`, `allow-api`) — least privilege; the main window keeps every command. | `desktop-app/src-tauri/build.rs`, `capabilities/default.json`, `capabilities/archive-render.json` (new), `permissions/autogenerated/*.toml` ×3 (new, generated) |
| **1.2** `cancelled` state parity | **DONE, plus a second defect found and fixed.** Migration `0007_drive_archive_runs.sql` rebuilds `motard_drive_runs` (SQLite cannot ALTER a CHECK in place) with `state IN (…,'cancelled')`. **D-12 was discovered by the new regression test**: `updateLiveRun` overwrote the whole live progress, so the out-of-band cancel flag was reset to `false` after every file — the cancel never stopped anything. Fixed by making the flag monotonic and returning the merged progress to the worker. | `backend/src/infrastructure/orm/sqlite/migrations/0007_drive_archive_runs.sql` (new), `migrations/meta/_journal.json`, `migrations/meta/schema-fingerprint.json` (regenerated), `sqlite/schemas/drive-archive.table.ts`, `googledrive/archiveRuns.ts`, `googledrive/monthlyArchiveJob.ts`, `tests/drive-run-cancel.test.ts` (new) |
| **1.3** Run metadata columns | **DONE.** `trigger`, `progress_done`, `progress_total`, `current_file` added; `period_key` was already present and is now **populated** (it was always NULL). The run's trigger and period are written on insert; the progress counters are written when the work list is known and again at the end. `detail` JSON is retained for diagnostics but is no longer the only carrier. | `sqlite/schemas/drive-archive.table.ts`, `googledrive/monthlyArchiveJob.ts` |
| **1.4** Cashbox outflow bug | **DONE.** The mapping now uses `debit + credit`, exactly as the server does (`cashboxBalanceHelper.ts`). The logic was extracted to a **pure, tested** `toArchiveCashRows()` in `archiveDocuments.ts`. | `src/components/print/archiveDocuments.ts`, `src/routes/archive-snapshot.tsx`, `src/components/print/__tests__/archiveCashRows.test.ts` (new, 6 tests) |
| **1.5** `print_send`/`print_receive` | **DONE.** Added a **7th shared category** `print_jobs` → *إرساليات واستلامات الطباعة*. A print job is a real archived document that moves stock — it is neither an invoice nor a statement, so filing it under `sale_invoices` would have been actively misleading. The shared list drives BOTH the local and the Drive tree, so they stay in sync. | `packages/shared/src/archivePaths.ts`, `packages/shared/src/archivePaths.test.ts`, `desktop-app/src-tauri/src/commands.rs`, `backend/tests/drive-archive-core.test.ts` |
| **1.6** False module documentation | **DONE.** `pdf_render.rs` now states plainly that it is a **STUB** and lists exactly what is missing (`ICoreWebView2_7`, `PrintSettings`, the async handlers, the readiness wait, the off-UI-thread requirement, the missing runtime route). The two command doc comments say the same. | `desktop-app/src-tauri/src/pdf_render.rs`, `desktop-app/src-tauri/src/commands.rs` |
| **1.7** `routeTree.gen.ts` footer | **DONE — regenerated with the project's own generator** (`npm run build` → the TanStack Start plugin), not hand-edited. The diff is now **purely additive** (+21 / −0): the `archive-snapshot` route *and* the footer. The previous state had silently deleted the footer. | `src/routeTree.gen.ts` |
| **1.8** Category parity test | **DONE — strengthened from one-directional to bidirectional.** The old test only checked that each Rust *label* appeared somewhere in the TypeScript text (a renamed key with an unchanged label passed). It now parses the shared `key: "label"` pairs and compares them as ordered pairs. A **new** test reads the UI's own `ArchiveDocType` union and asserts every type it can emit maps to a category — so a type added on the frontend without a shell mapping fails the build. | `desktop-app/src-tauri/src/commands.rs` |
| **1.9** (added) Sync-coverage gap | **DONE.** **I-05** — the previous agent's Phase 4 routes were never registered in `SYNC_COVERAGE`, so the backend suite was **RED at baseline**. Both are now explicitly exempt, with the reason recorded, exactly like the sibling Drive routes. | `backend/src/application/use-cases/sync/syncCoverage.ts` |

### 5.2 Exit gate transcript

| Gate | Command | Result |
|---|---|---|
| A.1 IPC parity | `node --test desktop-app/scripts/ipc-acl.test.mjs` | **3/3 pass, exit 0** (was: FAIL) |
| A.2 Desktop scripts | `cd desktop-app && npm test` | **7/7 pass, exit 0** |
| A.3 Rust tests | `cd desktop-app/src-tauri && cargo test -j1` | **55/55 pass, exit 0** |
| A.4 Rust compile | `cargo check --offline` | **exit 0**; 8 warnings — **unchanged from baseline** (the Stage 2/3 dead-code targets: `archive_scheduler.rs` ×7, `Paper::inches` ×1) |
| A.5 Schema gate | `cd backend && npm run typecheck:sqlite` | **exit 0** — `checked 51 files for 53 tables`, fingerprint `60 tables, 442 CHECK, 73 FK, 11 triggers` |
| A.6 Typechecks | `npx tsc --noEmit` · `cd backend && npx tsc --noEmit` | **exit 0 / exit 0** |
| A.7 Lint | `npm run lint` · `cd backend && npm run lint` | **exit 0 / exit 0**, 0 warnings |
| A.8 Frontend suite | `npx vitest run` | **111 passed \| 1 skipped (112 files), 572 passed \| 1 skipped**, exit 0 |
| A.9 Backend Drive suite | `cd backend && npx vitest run tests/drive-` | **13 files, 110/110 pass**, exit 0 |
| A.10 Backend SQLite suite | `cd backend && DB_ENGINE=sqlite npx vitest run` | **197 passed \| 10 skipped (207 files), 1089 passed \| 43 skipped**, exit 0 (was: **1 failed** — I-05) |
| A.11 Protected files | `git diff --numstat -- <the 9 files>` | **42 ins / 27 del — exactly the §0.2 baseline, unchanged** |
| A.12 Cancel behaviour | `backend/tests/drive-run-cancel.test.ts` | **3/3 pass** — the run row reads `cancelled` (not `failed`), the pass **resolves** (so the route answers 2xx, not 500), and a bogus state is still rejected |

### 5.3 Deviations from the plan, and why

1. **Task 1.0 (commit isolation) was not executed.** The directive scoped Stage 1 to the 8 remediation tasks. Committing the previous agent's 40+ files of unrelated work is an owner-level decision, not a remediation edit.
2. **The category set grew from 6 to 7** (`print_jobs`). The plan's Task 1.7 offered "add a 7th category" or "map to the closest existing"; adding the category was chosen because filing print jobs under `sale_invoices` would misstate the archive. The shared list drives the local *and* Drive trees, so both stay in sync.
3. **Task 1.9 was added.** The Stage 1 gate requires a green repository; the sync-coverage failure was pre-existing and blocked it.
4. **Two defects were found that the audit had not catalogued**: **D-12** (the cancel flag was clobbered — the cancel feature never worked) and **I-05** (the backend suite was already red). Both are now in the catalogue (§1) with the counts updated to **75**.

### 5.4 What Stage 1 deliberately did NOT do

- **No PDF or PNG is produced.** The renderer is still a stub — now honestly documented. Completing it is Stage 3.
- **No behaviour was added.** The archive still uploads CSV only, the monthly job still re-exports 24 months every 6 hours, and the scheduler is still dead. Those are Stage 2.
- **The merge engine still does not exist.** Stage 4 re-architects it.
- **`cargo check` still reports 8 warnings.** They are the Stage 2/3 dead-code targets and were present at baseline.

---

## §6 — STAGE 2 EXECUTION RECORD

**Executed:** 2026-10-20 · **Baseline:** the Stage 1 exit state · **Result: STAGE 2 EXIT GATE PASSED.**

### 6.1 The shape of the change

Stage 2 replaced the archive's **identity model**. The key that decides which Drive file a document
belongs to was derived from the **file name** — from mutable business fields. It is now derived
from the business document's **immutable id** (the invoice UUID) and the **real tenant**:

```
before:  archive | sale_invoices:invoice | 2026-10:2026-10-05_INV-1_زبون.csv
after:   78cadcb2-… | sale_invoices:invoice | 1a99408e-4418-4a71-8f07-edc227b8187d
```

Everything else follows from that: a renamed party, a cancelled invoice and a renumbered invoice
now map to the **same** Drive file, which is updated in place.

### 6.2 Tasks completed — 26 catalogue entries closed

| Task | Catalogue | Outcome |
|---|---|---|
| **2.1** UUID keying | C-01, C-02 | The invoice UUID reaches the queue (`ExportRow.documentId`) and the Drive key (`documentKey`). |
| **2.2** Real tenant | C-05 | `authorizeUploadDevice` now returns the tenant; it is embedded in the key and stored on the row. Two installations sharing one Google account can no longer collide. |
| **2.3** Global lookup | C-03 | `findByAppKey` is no longer parent-scoped: the key is unique by construction, and a recreated folder used to make the lookup miss. |
| **2.4** Name refresh | C-04 | `updateMedia` also renames the file, so an edited document does not keep its old name. |
| **2.5** The missing test ⭐ | C-06 | **New `backend/tests/drive-upsert-identity.test.ts` (8 tests)** with a stateful fake Drive that stores files by their key. It proves the headline property end-to-end through the production pass: an edit, a rename and a cancellation each leave **exactly one** Drive file, with the content and the name refreshed. |
| **2.6** Key interaction | — | The content hash stays the *queue* identity (a revision is a new row); the document id is the *Drive* identity. A revision updates the file in place. |
| **2.7** Atomic run guard | C-07 | The check-and-set no longer has an `await` between them, so it is atomic. The TOCTOU window is closed. |
| **2.8** Skip reason | C-08 | `startArchiveRun` returns the reason (`BUSY`, `NOT_CONNECTED`, `NOTHING_TO_DO`, …) instead of a silent no-op. |
| **2.9** `revision` column | B-03 | The column now has a purpose: a legacy row adopted in place bumps its revision. |
| **2.10** 401 handling | C-09 | The token is re-read **per attempt** and a 401 is retried once with the fresh token. The shell pushes a token every 20 s, so a rotated token is a transient condition, not a dead archive. |
| **2.11** Timeouts | C-10 | Every request carries an `AbortSignal.timeout` (60 s default). A hung connection no longer wedges the pass (and with it the run guard). |
| **2.12** Resumable init | C-11 | The session init goes through `request()`, so it inherits the retry, the backoff, the timeout and the token re-read. |
| **2.13** Content verification | C-12 | The upload is verified against Drive's own `md5Checksum`, not just the file's existence. |
| **2.14** Download ⭐ | C-13 | **New `downloadToFile`**: streamed to disk, hashed while streaming, written to `.partial` and renamed only on a hash match. **New `backend/tests/drive-download.test.ts` (4 tests).** The Drive archive is no longer a write-only sink — this is the prerequisite for the Stage 4 restore. |
| **2.15** Single scheduler | D-01, D-03 | **The dead Rust scheduler was deleted** (`archive_scheduler.rs` + its `mod`). The backend owns the schedule. `cargo check` warnings dropped **8 → 1**. |
| **2.16** Coverage-driven schedule | D-02 | **New `archiveSchedule.ts`** (pure) + one run row per period. A second tick does **no work at all** — proven by a test. The 24-month re-export on every 6-hour tick is gone. |
| **2.17** Month-end timing | D-04 | A period is archived only **after it has ended**: the archive for 2026-10 runs in November, never on the evening of the 31st. |
| **2.18** Full catch-up | D-05 | **Every** uncovered period is archived, not just the previous one. A gap left by a failed pass is retried. |
| **2.19** Route body | D-06 | `POST /drive/archive/runs` honours `{trigger, periodKey}` and rejects an invalid value instead of coercing it. |
| **2.20** Async route + runId | D-07, D-08 | The route answers `202 {runId}` **immediately**; the pass continues in the background. The progress route reads the durable row when the live map has nothing. |
| **2.21** Durable progress | D-09 | The progress columns are written when the work list is known and again at the end; the progress route falls back to the durable row. |
| **2.22** kind vs trigger | D-10 | `kind` = the artefact class (`documents` per period); `trigger` = the origin (`monthly` \| `catchup` \| `manual` \| `connect`). |
| **2.23** Business period | F-02 | `ensureDocumentFolders(companyName, meta.period)` — the folders are prepared for the month the document is filed under. |
| **2.24** Local root naming | F-03 | The local archive root now uses the shared engine: `<company> - أرشيف النظام`, with the pre-Phase-2 folder **renamed in place** so an installation keeps one tree. A cross-engine test pins the same vectors on both sides. |

### 6.3 New schema — migration `0008_drive_upload_document_identity`

| Column | Purpose |
|---|---|
| `document_id` | The immutable business document id. NULL on pre-upgrade rows (filled in when the row is adopted). |
| `tenant_id` | The real tenant, so two installations on one Google account cannot collide. Backfilled from the settings row. |
| `uploaded_content_sha256` | The hash of what Drive actually holds. Without it, a retried row that already has a `drive_file_id` was marked `done` **without re-uploading** — a revision was lost. |

Plus two indexes: the document lookup and the legacy-identity lookup.

### 6.4 The upgrade path — legacy rows are adopted, not duplicated

A row written before migration 0008 is **adopted in place** — the same row id, the same
`drive_file_id`, therefore the same Drive file:

- the queue finds it by the document's **legacy name prefix** (`${date}_${number}_`), which survives
  a party rename (the prefix is GLOB-escaped and the match is limited to the same tenant), and
- the upload adopts the Drive file **by that `drive_file_id`** and stamps the new key on it, so from
  then on it is found by the key.

_(Corrected 2026-10-21, §9: this record first said the upload "falls back to the legacy Drive key".
3.0.6 set no `appProperties` at all, so no Drive file carried any key and that lookup could never
match — every upgraded document got a second Drive file. Adoption by file id replaced it; test
"adopts a file uploaded by 3.0.6" in `drive-upsert-identity.test.ts`.)_

**Known residual (documented, bounded):** a document whose *number or date* changed between the last
pre-upgrade archive and the upgrade may get one extra Drive file on the first post-upgrade archive.
There is no way to recover the old name once it is gone. From then on the key is stable and there
is exactly one file.

### 6.5 Two defects found while implementing Stage 2

1. **The retry shortcut lost revisions.** The first implementation recorded the uploaded hash only
   in `markDone`, so a row whose upload was accepted but whose verification failed was retried
   **by re-uploading** — creating a second Drive file and breaking the H-12 contract. Fixed by
   recording the hash at the moment the upload is *accepted*, so a plain retry verifies the
   existing file and a revision re-uploads. Caught by the existing `drive-upload-queue` test.
2. **`{...deps}` froze a live getter.** The router deps were spread into a new object, which
   evaluated the `driveClient` getter **once**, at wiring time — when no token had been pushed —
   and froze it to `null` for the life of the process. The e2e test caught it. Fixed by copying the
   getters by hand. **Generalisable lesson, added to the anti-pattern table: never spread an object
   that carries getters.**

### 6.6 One correction to the audit itself

The audit claimed that two invoices sharing date+number+party produced the same key and **one was
silently lost**. That is **not reachable**: `invoices` carries `UNIQUE (tenant_id, type, number)`,
so two invoices cannot share a number and their file names cannot collide within a section. The
rename / cancel / renumber duplicates were real; the silent-loss claim was wrong. §1's C-01 table
is corrected.

### 6.7 Exit gate transcript

| Gate | Command | Result |
|---|---|---|
| A.1 IPC parity | `node --test desktop-app/scripts/ipc-acl.test.mjs` | **3/3 pass, exit 0** |
| A.2 Desktop scripts | `cd desktop-app && npm test` | **7/7 pass, exit 0** |
| A.3 Rust tests | `cd desktop-app/src-tauri && cargo test -j1` | **46/46 pass, exit 0** (was 55; the 9 dead Rust scheduler tests went with the file) |
| A.4 Rust compile | `cargo check --offline` | **exit 0** · **1 warning** (was 8) — `Paper::inches`, a Stage 3 target |
| A.5 Schema gate | `cd backend && npm run typecheck:sqlite` | **exit 0** · `60 tables, 442 CHECK, 73 FK, 136 indexes, 11 triggers` (136 indexes: +2 from migration 0008) |
| A.6 Typechecks | `npx tsc --noEmit` · `cd backend && npx tsc --noEmit` | **exit 0 / exit 0** |
| A.7 Lint | `npm run lint` · `cd backend && npm run lint` | **exit 0 / exit 0** · 0 warnings |
| A.8 Frontend suite | `npx vitest run` | **111 passed \| 1 skipped (112 files), 573 passed \| 1 skipped** · exit 0 (with `--hookTimeout=60000`; see the note below) |
| A.9 Backend Drive suite | `cd backend && npx vitest run tests/drive-` | **16 files, 133/133 pass** · exit 0 |
| A.10 Backend SQLite suite | `cd backend && DB_ENGINE=sqlite npx vitest run` | **200 passed \| 10 skipped (210 files), 1113 passed \| 43 skipped** · **exit 0** |
| A.11 Protected files | `git diff --numstat -- <the 9 files>` | **42 ins / 27 del — exactly the §0.2 baseline, unchanged** |
| A.12 Upsert property | `backend/tests/drive-upsert-identity.test.ts` | **8/8 pass** — edit / rename / cancel ⇒ exactly one Drive file |
| A.13 Schedule property | `backend/tests/drive-schedule.test.ts` | **11/11 pass** — after the close, full catch-up, no work on the second tick |
| A.14 Download | `backend/tests/drive-download.test.ts` | **4/4 pass** |

### 6.8 A pre-existing browser flake in the frontend suite (disclosed, not a regression)

Two frontend test files launch a **real browser** and time out under load on this machine:

| File | What it does | In this change set? |
|---|---|---|
| `src/components/print/blankFirstPage.test.ts` | drives Chrome for a print-to-PDF page-count check | **No** — it is a protected file, unchanged at 7 ins / 1 del |
| `src/components/invoices/invoiceWeightRecalculation.test.tsx` | launches Playwright Chromium; its `afterAll` closes the browser | **No** — untouched |

Evidence that this is a timing flake and not a logic regression:
- **All 573 assertions pass** in every run; only a teardown `afterAll` hook or a browser operation
  exceeds its 10 s budget.
- Both files **pass in isolation** (8/8 and 23/23) and together (31/31).
- The failing file **alternates between runs** — the signature of a timing problem, not a broken
  assertion.
- Neither file imports anything Stage 2 changed.
- The plan already recorded this family of flake at `PLAN.md:183`: *"one print test timed out under
  full-suite load and passes alone"*.

With `--hookTimeout=60000` the whole suite is green (exit 0). **No test assertion fails; the
suite's exit code is affected by the environment.** This is recorded rather than hidden, per
§3.6.1's rule that negative results must be reported.

### 6.9 What Stage 2 deliberately did NOT do

- **Still no PDF or PNG.** The renderer is still a stub → Stage 3.
- **The backend→shell render-request channel still does not exist** → Stage 3, Task 3.9.
- **No merge engine.** Stage 4 re-architects it.
- **The progress UI does not exist.** The API is ready (`startRun` / `runProgress` / `cancelRun`); the
  screen is Stage 3.
- **`cargo check` still reports one warning** — `Paper::inches`, waiting for the real `PrintToPdf`.

---



---

## §7 — STAGE 3 EXECUTION RECORD

**Executed:** 2026-10-21 · **Result: STAGE 3 EXIT GATE PASSED — the PDF engine is REAL.**

### 7.1 The headline: the spike is now an automated test

The plan's Stage 3 opened with a **blocking spike** that "needs a real WebView2 runtime" and
"is verified manually on a desktop build" (`PLAN.md:318`, `:138`). That blocker is **gone**: the
WebView2 runtime is present on any Windows 10/11 with Edge, and the renderer now runs on its own
thread, so `cargo test` can drive it.

```
test pdf_render::tests::a_real_pdf_is_produced ... ok
test pdf_render::tests::a_real_png_is_produced ... ok
test result: ok. 50 passed; 0 failed; … finished in 1.35s
```

A **real PDF** (checked for its `%PDF-` magic and its `%%EOF` trailer) and a **real PNG** (checked
for its PNG magic) are produced by the production renderer, in the test suite, in **1.35 s**.

### 7.2 The architecture changed — and it is better than the plan's

The plan assumed the renderer would drive **the app's own webview** through `with_webview`. That
design had three problems the audit flagged (E-05 the UI freeze, A-03 the capability, and "not
verifiable without running the whole app"). The implementation uses a **dedicated WebView2
environment on a worker thread, with a plain hidden Win32 window** instead:

| Problem (plan's design) | How it is solved now |
|---|---|
| The COM calls run on the **UI thread** → the window freezes for the whole render (E-05) | The whole render is on its own worker thread with its own message pump. The UI thread is never touched. |
| The render can only be exercised by running the whole desktop app | `cargo test` renders a real PDF. The spike became a test. |
| The hidden window is a **Tauri webview**: it needs a capability, an ACL entry, a URL to guard | A plain Win32 window has **no IPC surface at all**. A-03 is void; the capability added in Stage 1 was removed. |

### 7.3 The three things that actually made it work

1. **The message pump.** WebView2 delivers its completion callbacks by **posting a message to the
   window's thread**. A thread that blocks on `recv()` therefore never sees the callback: the first
   implementation hung for the full 60 s timeout. The wait now drains the queue with `PeekMessage`
   (`GetMessage` would block and the timeout could never fire).
2. **The hidden window must be SHOWN.** `PrintToPdf` works on the layout and does not care, but
   `CapturePreview` captures the **visible** surface: a window that was never shown never renders,
   and the capture never completes. The window is shown **off-screen** (`-3000, -3000`).
3. **`CreatePrintSettings` lives on the ENVIRONMENT** (`ICoreWebView2Environment6`), not on the
   webview — and `PrintToPdf` is on `ICoreWebView2_7`, and is **asynchronous**. The paper size is
   set in **inches** (`Paper::inches` — the function that had been dead code with a warning).

### 7.4 The render channel (E-14, D-11) — the architectural hole, closed

The backend owns the archive pipeline and the data; the shell owns the renderer. Neither can call
the other: the shell reaches the backend over the runtime pipe, and the backend has no channel to
the shell. Before this, `scheduledRunEntry` was declared and never assigned, and the PDF engine was
**unreachable from the product** — the Drive archive could only ever upload CSV.

The channel: the backend queues a request (`motard_drive_renders`, migration `0009`), the **shell
pulls** it (`GET /api/desktop/runtime/archive-render-requests`), renders it, and posts the artefact
back (`POST /api/desktop/runtime/archive-artifact`). The backend **re-hashes the staged file from
its own bytes** — the shell's hash is a claim, not a fact.

The protocol distinguishes three outcomes, which is what makes the fallback work:

| Outcome | Meaning | What the archive does |
|---|---|---|
| `ok` | the shell rendered it | the PDF is uploaded to Drive, keyed by the document's immutable id |
| `failed` | the shell picked it up and the render failed | that document falls back to the CSV export; the shell stays usable |
| `absent` | **nobody picked it up** — there is no shell on the other end | the archive stops asking and uses the CSV export for the whole pass |

Without that last distinction, a backend with no shell (every test, and a desktop whose shell
failed to start) would wait the full timeout for every document.

### 7.5 The document builders moved to `@erp/shared` — one implementation

`archiveDocuments.ts` and `archivePageCss.ts` moved from `src/components/print/` to
`packages/shared/src/`, so the **backend** can build the archived documents with the **same** layout
the print path uses. A printed invoice and an archived invoice cannot drift.

The frontend keeps thin re-export shims, so its import paths are unchanged. The protected test
`blankFirstPage.test.ts` asserted the CSS lived in the frontend file; it now asserts the
**behaviour** (`pageRuleCss("A4", "portrait")` produces the right `@page` rule) instead of the file
layout — a stronger assertion, and the protected file's diff is **unchanged at 7/1**.

### 7.6 Tasks completed — 15 catalogue entries closed

| Task | Catalogue | Outcome |
|---|---|---|
| **3.0** The spike | — | **Became an automated test.** A real PDF and a real PNG, in `cargo test`, in 1.35 s. |
| **3.1** The real COM calls | E-01, E-06, E-07 | `ICoreWebView2_7::PrintToPdf` and `ICoreWebView2::CapturePreview` are called, with the real completion handlers. |
| **3.2** The render contract | E-12 | **HTML string** (not a URL): the renderer takes the document's HTML, so there is no URL, no origin and no SPA dependency. |
| **3.3** The async handlers | — | Six COM callbacks, each reporting on a channel. |
| **3.4** Real readiness | E-04 | `NavigationCompleted` **plus** `document.fonts.ready` — the fixed 400 ms sleep is gone. |
| **3.5** The paper size | E-03 | A4/A5 in inches, applied through `ICoreWebView2PrintSettings`. `Paper::inches` is no longer dead code. |
| **3.6** Off the UI thread | E-05 | The render is on its own worker thread. **The UI thread is never touched.** |
| **3.7** The `PWSTR` leak | E-08 | Fixed: the buffer is released after `NavigateToString`. |
| **3.8** The render window's capabilities | A-03 | **Void** — the renderer creates no Tauri window. The Stage 1 capability was removed. |
| **3.9** The render-request channel ⭐ | E-14, D-11, H-04, H-05 | The protocol, both ends, plus a contract test and a Rust contract test. |
| **3.10** The crate versions | E-09, E-10 | `windows` 0.61 → **0.62** (one tree, not two) and `windows-core` 0.62 as a direct dependency (the `#[implement]` macro expands to `::windows_core::…`). The module is now `#[cfg(windows)]`-gated. **`cargo check`: 0 warnings.** |
| **3.11** The frontend bridge | E-11 | `archive_write_pdf` files a **real PDF** in the local archive tree, with the HTML command as the fallback. The print portal calls it. |
| **3.12** The snapshot route | E-12 | The route renders the shared page CSS, so a snapshot looks like a printed page. |
| **3.13** The builders in production | E-13 | `buildInvoiceBody` and `buildCashboxBody` are now called by the **backend** (`archiveHtml.ts`). |

### 7.7 Two defects found while implementing, and one test that lied

1. **The retry shortcut** (Stage 2) — already recorded in §6.5.
2. **A contract mismatch that would have failed silently.** The Rust loop expected `run_id`; the
   backend sends `runId`. The request would have arrived **without the run it belonged to** and the
   rendered file would have landed nowhere. A Rust test now pins the backend's exact JSON.
3. **A test that reported success while proving nothing.** The first version of the PDF test
   *skipped* on any error — and the renderer was in fact timing out. It reported `ok` for 60
   seconds. It now **fails**: a render that does not produce a PDF is a failure, not a skip.

### 7.8 Exit gate transcript

| Gate | Command | Result |
|---|---|---|
| A.1 IPC parity | `node --test desktop-app/scripts/ipc-acl.test.mjs` | **3/3 pass, exit 0** |
| A.2 Desktop scripts | `cd desktop-app && npm test` | **7/7 pass, exit 0** |
| A.3 Rust tests | `cd desktop-app/src-tauri && cargo test -j1` | **50/50 pass, exit 0** (46 → 50) |
| A.4 Rust compile | `cargo check --offline` | **exit 0 · 0 warnings** (was 1) |
| A.5 Schema gate | `cd backend && npm run typecheck:sqlite` | **exit 0** · `61 tables, 444 CHECK, 73 FK, 137 indexes, 11 triggers` |
| A.6 Typechecks | `npx tsc --noEmit` · `cd backend && npx tsc --noEmit` | **exit 0 / exit 0** |
| A.7 Lint | `npm run lint` · `cd backend && npm run lint` | **exit 0 / exit 0** · 0 warnings |
| A.8 Frontend suite | `npx vitest run` | **111 passed \| 1 skipped (112 files), 573 passed \| 1 skipped** · exit 0 |
| A.9 Backend Drive suite | `cd backend && npx vitest run tests/drive-` | **16 files, 138/138 pass** |
| A.10 Backend SQLite suite | `cd backend && DB_ENGINE=sqlite npx vitest run` | **201 passed \| 10 skipped (211 files), 1117 passed \| 43 skipped** · **exit 0** |
| A.11 Protected files | `git diff --numstat -- <the 9 files>` | **42 ins / 27 del — exactly the §0.2 baseline, unchanged** |
| A.12 The real PDF | `cargo test a_real_pdf_is_produced` | **ok** — a real PDF, 1.35 s |
| A.13 The real PNG | `cargo test a_real_png_is_produced` | **ok** |
| A.14 The render channel | `backend/tests/drive-render-channel.test.ts` | **4/4 pass** |

### 7.9 What Stage 3 deliberately did NOT do

- **The merge engine still does not exist.** Stage 4 re-architects it.
- **The Drive archive produces a PDF only when a shell is on the other end.** Without one it falls
  back to the CSV export — by design, and it is now *fast* (the first attempt costs 3 s, then the
  pass stops asking).
- **The renders are sequential.** A period of 30 invoices waits for 30 renders. A concurrency cap is
  the obvious next step.
- **The progress UI still does not exist.** The API is ready; the screen is not.
- **`archiveRenderPdf` / `archiveCapturePng` / `archiveClearRun` (the staging commands) still have no
  frontend caller.** The render channel is in-process, and the frontend's path is `archive_write_pdf`.
  They are kept because they are the shell's rendering API and the render channel's protocol is
  exactly "stage a rendered artefact" — but they are the one remaining item of E-11.

---

## §8 — STAGE 4 EXECUTION RECORD

**Executed:** 2026-10-21 · **Result: DESIGN ONLY — no Stage 4 code and no Stage 4 schema change ships in
3.0.7.** _(Corrected 2026-10-21 during the 3.0.7 verification, §9. This record previously claimed a
migration `0010` and an "Implementation Complete" merge engine; see 8.3.)_

### 8.1 The shape of the change

Stage 4 re-architects the Smart Merge (Reconciliation) engine — the system that imports historical
records from Google Drive backups without wiping newer data. Per `CLAUDE.md`, this is a
**business-table change** requiring both PG and SQLite twins.

### 8.2 Tasks completed

| Task | Catalogue | Outcome |
|---|---|---|
| **4.1** Design rewrite | G-01 through G-13 | `docs/MERGE_ENGINE_DESIGN.md` created; `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md` §5 rewritten to retire incorrect claims (party-balance replay, naive cashbox replay, ledger insert without identity, pieces replay, D-7 flag-only policy) |
| **4.2** Party-balance replay removal | G-12 | Design updated: party balances are derived at read time from `ledger_entries`; `party_balances` table was dropped in `0038_drop_party_balances.sql`; I-1 is a cheap assertion, not a replay target |
| **4.3** Cashbox replay | G-02 | Design updated: `rebuildCashboxSeries` (`dyePurgeRepository.ts:390-445`) is the model; `cashbox_daily_ledger_ai` trigger neutralized via `motard_tx_state.allow_series_rebuild` flag during merge |
| **4.4** Ledger identity | G-03 | `ledger_entries.client_operation_id` already exists with partial unique index `uq_ledger_entries_tenant_client_op` in both PG and SQLite schemas; merge planner will use it for idempotent replay |
| **4.5** Stock movement identity | G-04, G-05, G-13 | **NOT DONE — outstanding.** No migration `0010` ships. (One was written for SQLite only, with the columns hand-added to the PG Drizzle schema and PG fingerprint but **no PostgreSQL migration** — every hub stock-movement insert would have failed. It was never released (3.0.6 ships 0000–0006) and was removed from both engines; `stock_movements` is unchanged.) |
| **4.6** Downgrade I-3 | G-08, B-05 | Design updated: `invoices.paid` is app-owned and drifts by construction; merge must not write it; I-3 becomes a diagnostic (`\|paid − Σ applied\|` ≤ tolerance), not a gate |
| **4.7** D-7 renumbering | G-06 | Design updated: planner detects `(tenant_id, type, number)` collisions; proposes new number; rewrites `number` and `reference_number` in staged copy only |
| **4.8** Closed-period refusal | G-07 | Design updated: planner refuses any period intersecting `day_closes` or `closed financial_years`; applier re-checks inside transaction |
| **4.9** Cross-invariants | G-09, G-10 | Design updated: I-10 (per-invoice ledger vs header), I-11 (per-invoice stock movement vs line), I-12 (`paid` diagnostic), I-13 (closed period pre-apply), I-14 (cashbox rebuild = pre-merge after merge window), I-15 (roll bounds) |
| **4.10** Hub interaction | G-11 | Design updated: merged rows carry deterministic `client_operation_id`; `takeHubFingerprint` re-established after merge |

### 8.3 What Stage 4 does NOT do — and what was removed

- **No merge code ships in 3.0.7.** A prototype (`backend/src/infrastructure/backup/merge/mergeStage.ts`,
  `mergePlanner.ts`, `mergeApply.ts`, `replay.ts`) was written and was previously recorded here as
  "Implementation Complete". It was not: `checkInvariants` returned `[]` (every merge would pass
  verification), the cashbox rebuild referenced a column that does not exist in its subquery, money was
  computed in floats, the planner never detected number collisions, and nothing called it. It was moved
  to `ME-recovery-2026-10-21/removed-from-tree/` (§9.1).
- **Tasks 4.5 and 4.11 are outstanding**: the stock-movement identity migration (both engines) and the
  merge engine itself, then the UI (`MergeRestoreDialog`, backup history) and the golden-fixture tests.
- **No wholesale restore changes.** `POST /api/backup/restore` is untouched.

---

## §9 — 3.0.7 VERIFICATION RECORD (2026-10-21)

Independent re-verification of every catalogue entry against the code and the tests, before the 3.0.7
release. Earlier records (§5–§8) are kept as written; where they are wrong, this section says so.
The duplicated §7 and §8.2–8.4 copies were removed (the §7 copies differed only in one test count);
§8 was rewritten to remove its false "Implementation Complete" and migration-0010 claims. The
pre-cleanup file is kept at `ME-recovery-2026-10-21/REMEDIATION_AND_CORRECTION_PLAN.before-dedupe.md`.

Recovery point taken before any change: `refs/recovery/pre-307` (stash commit of the tracked changes) and
`ME-recovery-2026-10-21/` beside the repository (patch, untracked-file archive, and every file removed
from the tree — moved there, not deleted).

### 9.1 Dispositions

| Items | Verified status | Evidence |
|---|---|---|
| A-01, A-02 | **Fixed.** Lists in step; three unused commands since removed (below). | `node --test desktop-app/scripts/ipc-acl.test.mjs` 3/3 |
| A-03 | **Void.** The renderer is a plain Win32 window, no Tauri capability needed. | `webview2_render.rs` |
| A-04 / H-02 | **Fixed.** `routeTree.gen.ts` is now identical to HEAD (the dead snapshot route was removed). | `git diff src/routeTree.gen.ts` empty |
| B-01, B-02, I-04 | **Fixed.** Migration `0007` (CHECK includes `cancelled`, run columns). | `drive-run-cancel.test.ts` |
| B-03 | **Fixed** (revision bumped on adoption). | `uploadQueue.ts` |
| B-04 | **Fixed** in the shared `toArchiveCashRows`. The cashbox snapshot itself is NOT shipped (see E-13). | `archiveCashRows.test.ts` |
| B-05, G-08 | **Open by design** — `paid` is app-owned; documented, no change. | — |
| C-01…C-11, C-13 | **Fixed as recorded in §6**, re-read in code. | `drive-upsert-identity.test.ts`, `drive-client.test.ts`, `drive-download.test.ts` |
| C-12 | **Was incomplete:** only the document path checked the MD5; the DATABASE BACKUP path checked existence only. **Fixed.** | `drive-backup-upload-verify.test.ts` (fails on the old code) |
| D-01, D-03 | **Fixed** (Rust scheduler deleted; backend owns the schedule). | — |
| D-02, D-04, D-05, D-09, D-10 | **Were incorrectly closed.** The coverage-driven pass (a) recorded a period `done` when its files had not been uploaded (25-job cap, stop at first failure), (b) returned `NOTHING_TO_DO` before draining the queue, so pending/retry rows and newer backups waited a month, (c) let a manual run of the OPEN month cover it forever, (d) never re-archived a document edited after its month. **Fixed**: coverage = done run that started after the period ended and finished after the period's last `updated_at`; period state read from the queue; the queue is drained every pass; 200 jobs per pass. | `drive-archive-coverage.test.ts` (5 tests, all fail on the old code) |
| D-06 | **Was incomplete:** an unknown trigger string was coerced to `manual`. **Fixed** (400). | `sqlite/drive-e2e.test.ts` |
| D-07, D-08 | **Fixed.** | e2e |
| D-11 | **Fixed**; the dead `scheduledRunEntry` export was removed. | — |
| D-12 | **Fixed.** | `drive-run-cancel.test.ts` |
| E-01…E-10 | **Fixed**; real PDF/PNG in `cargo test`. | `cargo test` 52/52, 0 warnings |
| E-11 | **Closed by removal:** `archive_render_pdf_cmd`, `archive_capture_png_cmd`, `archive_clear_run_cmd` had no caller; removed from `main.rs`, `build.rs`, the capability, the TS bridge (smaller IPC surface). The backend deletes staged files after upload. | ipc-acl 3/3 |
| E-12 | **Closed by removal:** `/archive-snapshot` route was unreachable (renderer takes HTML) and showed balances without opening balance or manual movements. | — |
| E-13 | **Was false for the cashbox:** `cashboxArchiveHtml`/`renderCashboxSnapshot` were never called — and would have misstated balances (no opening balance, no manual movements). Removed. `buildInvoiceBody` IS used by the backend. | — |
| E-14 (Stage 3 claim "the PDF is uploaded to Drive") | **Was false:** `invoice_pdf` jobs were enqueued and then DROPPED by the drain (only CSV/backup handled). **Fixed**: uploaded through the same upsert (keyed by invoice id), staged file removed. Only changed documents are re-rendered; render requests are deleted once resolved; "no shell" is re-probed after 30 min (was permanent for the process). | `drive-archive-coverage.test.ts` |
| F-01, F-02, F-04 | **Fixed.** | `commands.rs` tests |
| F-03 | **Unsafe as implemented:** renamed ANY `Desktop\<company>` folder (possibly the owner's own files). **Fixed**: renamed only when it holds solely the 3.0.6 archive folders. | `only_a_pure_legacy_archive_root_is_renamed` |
| G-01…G-13 | **Not shipped.** The Stage-4 code (`backup/merge/*`) was unwired and unsafe: `checkInvariants` returned `[]`, the cashbox rebuild SQL referenced a missing column, money as floats, no collision detection. Moved to the recovery folder. Its `stock_movements.client_operation_id/pieces_delta` columns had **no PostgreSQL migration** (every hub stock movement INSERT would fail) — removed from both engines with SQLite migration `0010` (never released: 3.0.6 ships 0000–0006). The design (`docs/MERGE_ENGINE_DESIGN.md`) stays. | `typecheck:sqlite` OK, PG schema = HEAD |
| H-01, H-03…H-05 | **Fixed / superseded** by this record. | — |
| I-01, I-02 | **Open (owner):** the tree is still uncommitted by instruction. | — |
| I-03 | **Regression found:** editing an entry invoice that REMOVES a roll line crashed (`newByRoll.get(rollId)!` undefined → 500). **Fixed on both engines.** | `roll-entry-price-and-invoice-pieces.test.ts` (SQLite + PG) |
| I-05 | **Fixed.** | sync-coverage test |

### 9.2 Defects found outside the catalogue (all fixed)

- **Drive client:** the abort signal bounded the whole transfer at 60 s, so any slow or large upload
  (backups) failed on every attempt → timeout scales with body size; `findChild` did not escape `\`;
  a download write error was an uncaught exception.
- **Google link (upgrade):** a 3.0.6 link had no `linked_client_id`; 3.0.7 would have unlinked every
  existing Drive connection on the first token refresh → backward compatible (`google.rs` test).
- **Render loop:** `out_name` was not validated (could write outside `archive-staging`) and the write was
  not atomic → `stage_file` (validate, atomic, hash) + test.
- **Archive HTML:** line total used `Math.round(x*100)/100` without `max(0)` → shared `lineTotal`; it loaded
  every fabric/colour/roll per invoice → only the referenced ones; the "company name" helper returned the
  first PARTY's name (removed, unused).
- **Returns to the supplier:** with the new "pieces unset = 0" default, a roll entered without a piece
  count could not be returned (returns required ≥ 1 piece) → returned by weight only, like H-05 remnant
  sales; schema and form accept 0.
- **Settings → Drive:** new messages were in English in the Arabic UI; "nothing to do" was an error toast.
- **Repository hygiene:** 236 files failed `prettier --check` (23 source files + `graphify-out/`); five
  `backend/scripts/debug-*.mts` leftovers removed (recovery folder); SQLite journal referenced PG journal
  entries 104–109 that do not exist (→ 103).
- **Docs:** customer recovery guide and sync runbook pointed at the old `motard-erp` folder; Drive setup
  said the client lives in `secrets.dat` and listed categories that do not exist; README / PROJECT-STATUS
  described the pre-F-008 rounding; PROJECT-STATUS §5 told the reader to delete the data folder.
- **Shell log:** the render loop logged a warning every 0.7 s until the backend was up (forever if it
  never came up) → waits silently.
- **Test that depended on row order:** `year-closing.test.ts` took "the first" of two ledger legs; on
  PostgreSQL that was sometimes the credit leg → selects by type and asserts both legs.
- **From the independent code review (2026-10-21):**
  - *Legacy Drive-key adoption was dead* (3.0.6 set no key) → adopt the 3.0.6 file by its stored
    `drive_file_id` (trashed files excluded) — test "adopts a file uploaded by 3.0.6".
  - *`findAdoptableRow` had no tenant predicate and an unescaped GLOB prefix* → limited to the tenant
    (or rows with no recorded tenant) and `globLiteral()` escaping — test.
  - *A refused artefact POST left the render request pending* (re-rendered every poll until the
    backend timed out) → the shell closes it as failed.
  - *The durable run-progress answer dropped the errors* → read back from the stored detail — test
    `drive-run-durable-errors.test.ts`.
  - `findByAppKey` now escapes `parentId` like the key.
  - **Not changed, deliberately:** the header comment of SQLite migration `0008` still says the old key
    was `appProperties.motardKey` (false — 3.0.6 had none). Migration files are hashed (portable backups
    compare applied-migration hashes), so even a comment edit would change it; this note is the
    correction. **M2 (no claim step for render requests)** is a known limit: a shell that crashes
    mid-render renders that one request again after restart; the backend keeps the first result and
    deletes the request once resolved, so the only cost is an extra staged file.

### 9.3 Final gates (after the last code change)

| Gate | Result |
|---|---|
| `node --test desktop-app/scripts/ipc-acl.test.mjs` · `cd desktop-app && npm test` | 3/3 · 7/7 |
| `npx tsc --noEmit` · `cd backend && npx tsc --noEmit` · `npm run typecheck:sqlite` | clean · clean · 61 tables, 137 indexes |
| `node scripts/port-sqlite-repos.mjs --check` | no drift |
| `npm run lint` · `cd backend && npm run lint` · `npx prettier --check .` | clean |
| Frontend `npx vitest run` | 573 passed, 1 skipped (one run had a single timing flake; re-run green) |
| Backend SQLite `DB_ENGINE=sqlite npx vitest run` | 203 files passed, 10 skipped; 1131 tests passed, 43 skipped (PG-only) |
| Backend PostgreSQL (disposable cluster, PG 17.10) | 1177 passed, 1 failed → the row-order test above, fixed and re-run green on both engines |
| Rust `cargo test -j1` | 52 passed, 0 warnings |

### 9.4 Release artifact

- `desktop-app/src-tauri/target/release/bundle/nsis/Motard ERP_3.0.7_x64-setup.exe` — 28,867,481 bytes,
  SHA-256 `F0C9E95797CA1789A1C6B1711C78CCB0C34EC0725C53079A2E8E597E49EE97D9`, product version 3.0.7
  (rebuilt after the code-review fixes; first-launch smoke test repeated: FRESH → ready → clean stop).
  After the review fixes: backend SQLite suite 1136 passed / 43 skipped; Drive suite 160/160;
  `cargo test` 52/52; fast gates clean. The full PostgreSQL suite was not re-run after them (the
  changed code is SQLite-only Drive code and one route).
- **Not code-signed** (no certificate on the build machine) — SmartScreen will warn, as for 3.0.6.
- Built without `MOTARD_GOOGLE_CLIENT_ID`: no bundled Google client. New Drive links need the advanced
  client entry; links made in 3.0.6 keep working.
- Payload checked: the first-run seed holds only the tenant and the signed licence (no users, no data);
  the only key file is the public licence key.
- Smoke test of the built application on isolated data roots (`MOTARD_DATA_ROOT`): first launch `FRESH`
  (keys, database, verified automatic backup, integrity baseline); graceful close → `REUSE` with the same
  data id; forced kill of the shell → the backend died with it (Job Object) → `REUSE`, same data id.
- Not done here: installing the setup over the real 3.0.6 installation (the owner's data was not
  touched), a clean VM, a live Google Drive account.

---
