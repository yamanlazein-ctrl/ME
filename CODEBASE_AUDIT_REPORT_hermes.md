# MOTARD FABRICS ERP — EXHAUSTIVE CODEBASE AUDIT

**Repository:** `C:/Users/Taw/Downloads/Compressed/q/ME-main` (true root, verified with `git rev-parse --show-toplevel`)
**Audit state:** HEAD `2b9b602cb1f5e74c9db2fd39a1aae8c11fbb79f7` — "Sync full working tree: audit fixes, Drive archive, e2e/Sentry setup, statement order, form labels"
**Working tree:** CLEAN at audit start — `git status --porcelain` returned 0 lines. The large uncommitted changes this repo historically carried were committed in this sync commit, so every file on disk is attributable to HEAD.
**Remotes:** `origin`/`github` → github.com/yamanlazein-ctrl/ME · `gitlab` → gitlab.com/getgovohoho-group/aaa. `HEAD...@{u}` = `0 0` (level with origin/main).
**Mode:** READ-ONLY. No product code, configuration, lockfile, schema, migration or database modified. No commits. No destructive git. The only files written are this report and the machine-readable findings index.
**Method:** 7 parallel subsystem audits (frontend A/B/C, backend D/E/F, database+CI+tests G) plus lead-auditor static-tool execution and direct verification of every material claim. Every claim carries `file:line` from the tree at HEAD.

> **FILENAME COLLISION NOTICE.** An unrelated whole-repository audit was written to
> `CODEBASE_AUDIT_REPORT.md` by another process at 18:58, overwriting this document. This report has
> been relocated to `CODEBASE_AUDIT_REPORT_hermes.md`. Its findings are independent of and do not
> supersede that document; where both cover the same ground, compare evidence rather than assuming
> agreement. HEAD was unchanged throughout (`2b9b602c`) and no repository file was modified by either
> audit.

---

## 1. ARCHITECTURE MAP

```
desktop/src-tauri/src (Rust, Tauri 2, 21 files, ~8.0k lines)
   |  main.rs (invoke_handler) · identity.rs · secret_store.rs (DPAPI)
   |  document_archive.rs (HTML→PDF via headless Chromium) · runtime/* (sidecar supervisor)
   |  spawns ─────────────────────────────────────────────────────────┐
   |                                                                  v
   |                                    backend/src (Express + Drizzle, 506 files, ~48.1k lines)
   |                                       presentation/server.ts — the single wiring point
   |                                         |- middleware chain (requestId → userFacingErrors →
   |                                         |   express.json(10mb) → installGate → dataSafeMode)
   |                                         |- apiRouter: authMiddleware → licenseHeartbeat →
   |                                         |   licenseGuard → per-module requireFeature
   |                                         |- 32 route modules + sync/drive/backup/integrity
   |                                         \- errorHandler
   |                                       application/use-cases/** (20 domains)
   |                                       domain/** (entities, invoices rules, value-objects)
   |                                       infrastructure/
   |                                         |- repositories/Postgres*.ts  <- hub engine
   |                                         |- repositories/sqlite/Sqlite*.ts <- desktop engine
   |                                         |- orm/{schemas,sqlite/schemas,migrations} x2
   |                                         |- auth · backup · sync · googledrive · device · audit
   |                                         \- di/container.ts
   |                                              ^
src/ (React SPA, TanStack Router, 492 files, ~65.5k lines)          |
   routes/*.tsx (53) -> presentation/hooks -> infrastructure/*      |
   infrastructure/tauri-bridge.ts -- named-pipe IPC ────────────────┘

packages/shared (24 files, ~1.7k lines) — precision.ts round2dp, shared schemas
```

### Engine duality (load-bearing constraint)
Every repository exists as a `Postgres*` file and a `repositories/sqlite/Sqlite*` twin. A rule implemented
in one and absent in the other is a defect, not a style issue. Schema changes require migrations for both
engines with journals kept in step. **Verified: 0 of 37 pairs diverge on any behavioural signal (F-009).**

### Route inventory — frontend (53 files, all in `src/routes/`)

| # | Route file | LOC | Audited by |
|---|---|---|---|
| 1 | `__root.tsx` | 180 | B |
| 2 | `index.tsx` (dashboard) | — | B |
| 3 | `login.tsx` | — | B |
| 4 | `invoices.index.tsx` | 372 | A |
| 5 | `invoices.$id.tsx` | 408 | A |
| 6 | `invoices.sale.new.tsx` | 1103 | A |
| 7 | `invoices.entry.new.tsx` | 1586 | A |
| 8 | `invoices.print-send.new.tsx` | 608 | A |
| 9 | `invoices.print-receive.new.tsx` | 667 | A |
| 10 | `invoices.tracking.tsx` | 730 | A |
| 11 | `returns.index.tsx` | 177 | A |
| 12 | `returns.sale.new.tsx` | — | A |
| 13 | `returns.entry.new.tsx` | — | A |
| 14 | `orders.index.tsx` | 386 | A |
| 15 | `orders.new.tsx` | 543 | A |
| 16 | `orders.$id.tsx` | 242 | A |
| 17 | `receipts.new.tsx` | — | B |
| 18 | `receipts.index.tsx` | 257 | B |
| 19 | `payments.new.tsx` | — | B |
| 20 | `payments.index.tsx` | 255 | B |
| 21 | `cashbox.tsx` | 567 | B |
| 22 | `expenses.new.tsx` | 235 | B |
| 23 | `expenses.index.tsx` | 156 | B |
| 24 | `ledger.tsx` | 214 | B |
| 25 | `customers.index.tsx` | — | B |
| 26 | `customers.$id.tsx` | — | B |
| 27 | `suppliers.index.tsx` | — | B |
| 28 | `suppliers.$id.tsx` | — | B |
| 29 | `inventory.tsx` | 469 | B |
| 30 | `inventory_.count.tsx` | 501 | B |
| 31 | `inventory_.adjustments.tsx` | 181 | B |
| 32 | `sync.conflicts.tsx` | 187 | B |
| 33 | `reports.tsx` | — | C |
| 34 | `reports.index.tsx` | 638 | C |
| 35 | `reports.$slug.tsx` | 774 | C |
| 36 | `print-center.tsx` | — | C |
| 37 | `closing.tsx` | 328 | C |
| 38 | `settings.tsx` (shell) | — | C |
| 39 | `settings.index.tsx` | — | C |
| 40 | `settings.backup.tsx` | 340 | C |
| 41 | `settings.sync.tsx` | 510 | C |
| 42 | `settings.company.tsx` | — | C |
| 43 | `settings.drive.tsx` | 299 | C |
| 44 | `settings.invoice.tsx` | 192 | C |
| 45 | `settings.payment-methods.tsx` | 125 | C |
| 46 | `settings.printing.tsx` | — | C |
| 47 | `settings.users.tsx` | 262 | C |
| 48 | `settings.units.tsx` | 144 | C |
| 49 | `settings.warehouses.tsx` | 144 | C |
| 50 | `settings.activity.tsx` | — | C |
| 51 | `__tests__/settings.backup.test.tsx` | 125 | (test) |
| 52 | `README.md` | — | (doc) |
| 53 | *(routeTree.gen.ts — generated, not a page)* | — | — |

### Route inventory — backend (37 route modules, ~270 endpoint registrations)

| Route module | Endpoints | Auditor |
|---|---|---|
| `sync.route.ts` | **37** | F |
| `party.route.ts` | 17 | D |
| `license.route.ts` | 11 | F |
| `cashbox.route.ts` | 11 | E |
| `ledger.route.ts` | 10 | E |
| `voucher.route.ts` | 9 | E |
| `setup.route.ts` | 9 | F |
| `year-closing.route.ts` | 8 | E |
| `order.route.ts` | 8 | D |
| `auth.route.ts` | 8 | D |
| `roll.route.ts` | 7 | D |
| `invoice.route.ts` | 7 | D |
| `search.route.ts` | 6 | F |
| `notification.route.ts` | 6 | F |
| `expense.route.ts` | 6 | E |
| `color.route.ts` | 6 | D |
| `user.route.ts` | 5 | D |
| `print.route.ts` | 5 | F |
| `invitation.route.ts` | 5 | F |
| `fabric.route.ts` | 5 | D |
| `drive.route.ts` | 5 | F |
| `statement.route.ts` | 4 | E |
| `return.route.ts` | 4 | D |
| `reports.route.ts` | 3 | E |
| `integrity.route.ts` | 3 | F |
| `health.route.ts` | 3 | F |
| `desktopRuntime.route.ts` | 3 | F |
| `company.route.ts` | 3 | F |
| `syncEnrollment.route.ts` | 2 | F |
| `syncBootstrap.route.ts` | 2 | F |
| `settings.route.ts` | 2 | F |
| `profit.route.ts` | 2 | E |
| `dye.route.ts` | 2 | D |
| `audit.route.ts` | 2 | F |
| `documentTrack.route.ts` | 1 | F |
| `dashboard.route.ts` | 1 | E |
| `fx.route.ts` | 1 | E |
| `backup.route.ts` | 8 | F |

---

## 2. STATIC TOOL RESULTS ACTUALLY EXECUTED

Every row below was run by the lead auditor at HEAD `2b9b602c`. The exit code is the **process's own**
code, never a piped `tail`'s.

| Command | Exit | Verbatim key output | Class |
|---|---|---|---|
| `npx tsc --noEmit` (root) | **0** | no output | TEST-EXECUTED |
| `cd backend && npx tsc --noEmit` | **0** | no output | TEST-EXECUTED |
| `npm run lint` (root) | **1** | `✖ 295 problems (245 errors, 50 warnings)` | TEST-EXECUTED |
| `npx prettier --check .` | 1 | `Code style issues found in 812 files` | TEST-EXECUTED |
| `npm audit --omit=dev --audit-level=high` (root) | **0** | `found 0 vulnerabilities` | TEST-EXECUTED |
| `npx vitest run backend/tests/migrations-journal-guard.test.ts backend/tests/schema-migration-parity.test.ts` — from the repo root, exactly as CI line 55 runs it | **1** | `No test files found, exiting with code 1` / `include: src/**/*.test.ts, src/**/*.test.tsx, packages/shared/src/**/*.test.ts` | TEST-EXECUTED |
| `cd backend && npx vitest run ../../src/contracts/reports.dfp015.test.ts` — simulating CI line 98's second command | **1** | `No test files found, exiting with code 1` / `include: tests/**/*.test.ts, src/**/*.test.ts` | TEST-EXECUTED |

### NOT RUN — environmental blockers (NOT VERIFIED, explicitly not claimed as passes)

| Suite | Reason |
|---|---|
| `npx vitest run` (frontend, 74 files) | 7.9 GB RAM total; free memory measured at **~410 MB** while the audit agents held the CPU. The repo's own rule (`CLAUDE.md`, "RAM is tight (~7.7 GB)… run heavy suites one at a time") forbids the concurrent run. |
| `cd backend && DB_ENGINE=sqlite npx vitest run` (~3–4 min) | Same memory constraint. |
| `cargo test` (desktop/src-tauri) | Same memory constraint. |
| `npm run typecheck:sqlite` | Same memory constraint. |
| Live PostgreSQL / RLS / multi-device drill | No hub database contacted; the audit is read-only and holds no credentials. |
| Playwright e2e / TesterArmy `npm run test:agentic` | Requires a live backend+UI stack (ports 18080/18081, `E2E_ADMIN_PASSWORD`). Not attempted. |
| `npm audit` backend, dev-dependency profile | Only the production profile CI enforces was run; the dev profile is not claimed clean. |

**Audit hygiene.** The known `--reporter=basic` false-pass (vitest v4, ERR_LOAD_URL, exit 0, zero tests)
was avoided — every run used a plain `run` and its summary line was read before recording. Two
exploratory runs were piped through `tail` and both reported a misleading `EXIT=0`; they were
**re-run unpiped**, which is how the true `exit 1` was established. That trap is why the exit-code
column above records process codes only.

---

## 3. CONFIRMED DEFECTS — CI AND BUILD GATES

### F-001 — Two CI steps can never execute a single test; they fail for the wrong reason
- **location:** `.github/workflows/ci.yml`
- **file:** `.github/workflows/ci.yml:55` and `.github/workflows/ci.yml:98`
- **type:** integration defect (CI gate silently non-functional)
- **severity:** **High**
- **evidence:**

```yaml
ci.yml:54-55
  - name: Migration and schema authority guards
    run: npx vitest run backend/tests/migrations-journal-guard.test.ts backend/tests/schema-migration-parity.test.ts
```
```ts
vitest.config.ts:8    // the root config — in force when line 55 runs from the repo root
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "packages/shared/src/**/*.test.ts"],
```
```yaml
ci.yml:95-98
  - name: SyncConflicts tenant guard + report contracts (DFP-019 / DFP-015)
    run: |
      cd backend && npx vitest run tests/sync-conflicts-tenant-guard.test.ts
      npx vitest run src/contracts/reports.dfp015.test.ts
```
```ts
backend/vitest.config.ts:33   // resolved from backend/, where line 98's second command runs
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
```

- **actual:** Line 55 runs from the repo root, so the root config applies and its `include` covers only
  `src/**` and `packages/shared/src/**`. The two `backend/tests/...` paths fall outside every include
  glob. Executed verbatim as CI does: `No test files found, exiting with code 1`, exit **1**. The guards
  this step exists to enforce — journal↔SQL resolution and schema-migration parity — never run.
  Line 98 is the mirror image: the multi-line `run` leaves the shell in `backend/` for its second
  command, so `src/contracts/reports.dfp015.test.ts` is matched against the *backend* config's
  `tests/**` + `src/**` globs — resolved from `backend/`, where that path does not exist. Simulated,
  it also exits **1** with `No test files found`.
- **expected:** each step runs from the directory whose vitest config covers the tests it names —
  `cd backend && npx vitest run tests/…` for backend suites; line 98's second command either moves
  above the `cd` or becomes its own root-level step.
- **affected:** `.github/workflows/ci.yml:55`, `.github/workflows/ci.yml:98`. Both target files exist on
  disk (verified with `ls`), so this is a wrong-directory bug, not a stale path.
- **confidence:** **Confirmed** — reproduced twice with real, unpiped exit codes.
- **regression test:** a CI step that runs both commands exactly as written and asserts the string
  `No test files found` does **not** appear in the output.

### F-002 — `npm run lint` fails outright; the repo cannot pass its own CI Lint gate
- **location:** repo-wide, `src/`
- **file:** failures concentrated in `src/routes/settings.drive.tsx:43,44,111,167,178,186,198,221,224,226,230,235,245,262,275`, `src/routes/settings.sync.tsx:187,191,292`, `src/shared/utils/supplierMatch.ts:39`, `src/routes/orders.new.tsx:157`, plus ~200 more
- **type:** maintainability / style (build-breaking)
- **severity:** **High** — a hard CI failure, though it carries no runtime risk
- **evidence:**

```
$ npm run lint                      # eslint src --max-warnings 50
✖ 295 problems (245 errors, 50 warnings)
  244 errors and 1 warning potentially fixable with the `--fix` option.
exit=1

src/shared/utils/supplierMatch.ts:39  error  Delete trailing newline   prettier/prettier
src/routes/orders.new.tsx:157         error  Replace `page={apg.page} …` with the multi-line form   prettier/prettier
src/routes/settings.drive.tsx:674     error  Insert ` Admin` / :675 Delete ` Admin`   prettier/prettier

$ npx prettier --check .
Code style issues found in 812 files.
```

- **actual:** `npm run lint` exits **1**. All 245 errors are the `prettier/prettier` rule surfaced
  through ESLint; the 50 warnings are `@typescript-eslint/no-explicit-any` and
  `react-refresh/only-export-components`. Independently, `prettier --check .` flags **812 files**.
- **expected:** `CLAUDE.md` → "Known open issues" states "Lint warnings are at exactly 50 (the limit):
  any new warning fails the gate." That describes the warning count only and is materially stale — the
  245 errors are a separate, harder failure the note does not mention.
- **confidence:** **Confirmed** — executed, exit code read directly from the process.
- **remediation risk:** `npx prettier --write` clears 244 of the 245 mechanically, but it rewrites 812
  files and would bury any functional change in an enormous diff. Reformat in a dedicated commit,
  separately from behaviour changes.

### F-003 — `npm audit` is clean; the older audit's 14/10 vulnerability counts are resolved
- **type:** informational (positive finding — recorded so a future audit does not re-flag it)
- **severity:** Informational
- **evidence:** `npm audit --omit=dev --audit-level=high` → `found 0 vulnerabilities`, exit **0**.
- **note:** `MOTARD_ERP_FULL_FORENSIC_AUDIT.md` §1 records 14 root vulns (1 critical / 8 high /
  5 moderate) and 10 backend vulns. The production-dependency profile now reports zero. The
  dev-dependency profile was not re-run and is **not** claimed clean.

---

## 4. CONFIRMED DEFECTS — DATABASE, RLS AND SCHEMA

### F-004 — The FORCE-RLS sweep exempts only `revoked_tokens` by name, yet six other tables have a NULLABLE `tenant_id`
- **location:** `backend/src/infrastructure/orm/migrations/20260923_force_rls_all_tenant_tables.sql`
- **file:** `backend/src/infrastructure/orm/migrations/20260923_force_rls_all_tenant_tables.sql:19-31`
- **type:** data integrity / security
- **severity:** **High** — runtime effect unverified (no live PostgreSQL)
- **evidence:**

```sql
    AND c.relname <> 'revoked_tokens'          -- the ONLY name-based exemption
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid
        AND a.attname = 'tenant_id'
        AND a.attnum > 0
        AND NOT a.attisdropped
    )                                           -- does NOT test a.attnotnull
LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
```

Tables whose `tenantId` is **nullable** in the PG schema (lead auditor, read from `orm/schemas/*.table.ts`):

| Schema file | `tenantId` declaration |
|---|---|
| `license.table.ts` | `uuid("tenant_id").references(() => tenants.id)` — no `.notNull()` |
| `license-audit-event.table.ts` | `uuid("tenant_id").references(() => tenants.id)` — no `.notNull()` |
| `secret.table.ts` | `uuid("tenant_id").references(() => tenants.id)` — no `.notNull()` |
| `server-installation.table.ts` | `uuid("tenant_id").references(() => tenants.id)` — no `.notNull()` |
| `setup-wizard-state.table.ts` | `uuid("tenant_id") .primaryKey() .references(() => tenants.id)` — no `.notNull()` |
| `sync-state.table.ts` | `uuid("tenant_id") .primaryKey() .references(() => tenants.id)` — no `.notNull()` |
| `revoked-token.table.ts` | `uuid("tenant_id")` — no `.notNull()` — **this one IS exempted** |

- **actual:** the loop selects every `public` table that *has* a `tenant_id` column, regardless of
  nullability, and force-enables RLS on it. Only `revoked_tokens` escapes, by hard-coded name.
  `sync_state` is the sharpest case: its `tenant_id` is the **primary key** of a one-row-per-tenant
  table, and a row with NULL `tenant_id` cannot match any
  `tenant_id = NULLIF(current_setting(...),'')::uuid` policy.
- **expected:** a structural exemption (e.g. also `AND a.attnotnull`, or an explicit allow-list of
  platform-managed tables), not a name. `revoked_tokens` was repaired by name in
  `20260927_revoked_tokens_no_rls.sql`; the same bug class survives for the six tables above.
- **mitigation already present (why High, not Critical):**
  `20260929_rls_nullif_guard_license_platform.sql` grants `licenses`, `secrets`,
  `server_installations`, `license_audit_events`, `setup_wizard_state` (plus `license_activations`,
  `device_registrations`, `invitation_codes`) a canonical `platform_or_tenant` policy that also admits
  `app.platform_mode = 'on'`. Five of the six therefore do have a policy — but **`sync_state` does
  not**: a grep for `CREATE POLICY … ON sync_state` across every migration and `rls/enable-rls.sql`
  returns **zero** matches, even though `sync_state` *is* listed in the text-comparison policy array at
  `rls/enable-rls.sql:71`.
- **affected:** `sync_state` (no policy — highest risk), `setup_wizard_state`, `secrets`, `licenses`,
  `server_installations`, `license_audit_events` (policies exist via 20260929).
- **confidence:** **Confirmed** for the code structure (nullable columns + name-only exemption, both
  read directly from the tree). **NOT VERIFIED** for the runtime effect — whether a forced table
  actually returns 0 rows to the app role was not tested against a live database.
- **reproduction:** on a migrated `erp_test` database, as the `NOBYPASSRLS` app role with no tenant
  context, `SELECT count(*) FROM sync_state;` — 0 rows against a correct database proves the defect.
- **regression test:** a migration-time assertion that every table under FORCE RLS has at least one
  policy, executed as the app role.

### F-005 — Schema and journal parity hold; the older audit's parity concerns are resolved
- **type:** informational (positive finding)
- **severity:** Informational
- **evidence** (lead-auditor script against HEAD):

```
PG schema tables: 47   SQLite schema tables: 52
PG-only (missing in SQLite): none
SQLite-only (no PG twin): drive-archive, financial-operation, motard-meta, sync-conflict, sync-tombstone
Column parity across the 47 shared tables: NO differences
PG migrations: 103 .sql files, 103 journal entries   → consistent
SQLite migrations: 6 .sql files, 6 journal entries   → consistent
```

- **notes:** the 5 SQLite-only tables are the documented desktop-only set (Drive archive tables,
  `financial_operations`, the hand-written `motard_meta`, and the sync tombstone/conflict ledgers) —
  expected, not drift. Every SQLite schema file carries the mandated
  `GENERATED by scripts/generate-sqlite-schema.mts … Do not edit by hand` header.
  Column parity was established only after correcting **three successive false positives** in the lead
  auditor's own parser (§11); the final pass compares column declarations only, excluding the
  `(table) => ({ … })` index/constraint callback that SQLite declares in `0000_baseline.sql` instead —
  e.g. `idx_cashbox_sessions_tenant_currency` appears in the PG schema *and* at
  `sqlite/migrations/0000_baseline.sql:1501`.
- **confidence:** Confirmed — scripted comparison of both schema trees and both journals.

### F-006 — Monetary columns passed through a `REAL` (float) representation in migration history
- **location:** `backend/src/infrastructure/orm/migrations/`
- **file:** `backend/src/infrastructure/orm/migrations/0024_monetary_fields_to_decimal.sql:9-55`
- **type:** data integrity (historical migration; current schema is correct)
- **severity:** **Medium** — nil for new databases, real for any database live while 0024 applied
- **evidence:**

```
0024_monetary_fields_to_decimal.sql:9   ALTER TABLE invoices ALTER COLUMN subtotal TYPE REAL;
0024_monetary_fields_to_decimal.sql:13  ALTER TABLE invoices ALTER COLUMN total    TYPE REAL;
0024_monetary_fields_to_decimal.sql:20  ALTER TABLE ledger_entries ALTER COLUMN debit TYPE REAL;
0024_monetary_fields_to_decimal.sql:31  ALTER TABLE vouchers ALTER COLUMN amount  TYPE REAL;
0024_monetary_fields_to_decimal.sql:44  ALTER TABLE cashbox_sessions ALTER COLUMN opening_balance TYPE REAL;
   … 33 monetary columns in total, incl. parties.opening_balance, expenses.amount, day_closes.*

0026_monetary_amounts_to_bigint.sql:16  ALTER TABLE invoices ALTER COLUMN subtotal TYPE BIGINT USING subtotal::BIGINT;
0036_live_monetary_hardening.sql:14    ALTER TABLE invoices ALTER COLUMN subtotal TYPE BIGINT USING subtotal::bigint;
```

- **actual:** money went integer → `REAL` (0024) → `BIGINT` (0026) → `BIGINT` (0036). `REAL` is a
  4-byte IEEE-754 float; any database live while 0024 was applied had its monetary columns rounded to
  ~7 significant digits, and 0026's `::BIGINT` cast then truncated that already-lossy value.
- **expected:** money is scaled-integer throughout; `REAL` should never have been an intermediate state
  for a monetary column.
- **current state:** the live schema declares `numeric(p, s, { mode: "number" })` and the `round2dp`
  contract holds, so a database created from the current head is correct.
- **confidence:** **Confirmed** for the migration text; the magnitude of any historical corruption is
  **NOT VERIFIED** (no production database inspected).
- **remediation risk:** any repair is a data migration over live financial history; it must be gated by
  an owner decision and reconciled against `ledger_entries`, never applied blind.

---

## 5. CONFIRMED DEFECTS — TEST COVERAGE

### F-007 — Twelve backend use-case subsystems have no subsystem-named test file
- **location:** `backend/src/application/use-cases/**` vs `backend/tests/**`
- **file:** lead-auditor script over `backend/src/application/use-cases/` and `backend/tests/`
- **type:** testing gap
- **severity:** **Medium**
- **evidence:**

```
use-case subsystems: 20
backend test files: 139
subsystems with NO test file naming them (12):
  dashboard, expenses, inventory, notifications, orders,
  parties, printing, returns, settings, statements, super-admin, vouchers
```

- **actual:** no file under `backend/tests/` has a name mentioning these twelve subsystems.
- **method caveat — read this before acting:** this is a **filename** match, not proof of zero coverage.
  A test named `financial-lock-in.test.ts` may exercise vouchers and statements thoroughly without
  naming them. The finding is "no subsystem-named test file"; each subsystem needs a content-level
  check before it is called untested.
- **confidence:** **Confirmed** for the filename absence (scripted over the real trees); the stronger
  conclusion "these subsystems are untested" is **Suspected**.
- **positive counter-finding:** a grep for `it.skip`, `it.todo`, `it.only`, `describe.skip`, `xit`,
  `xdescribe` across `backend/tests/`, `backend/src/`, `src/` and `packages/shared/src/` returned
  **0 markers** — no test anywhere in the audited trees is silently skipped.

---

## 6. ARCHITECTURE-LEVEL OBSERVATIONS (not defects)

1. **The two-engine split is genuinely mirrored.** Column parity holds across all 47 shared tables, both
   journals resolve exactly, and the SQLite schema files are generated artefacts carrying the
   do-not-edit header. The `Postgres*`/`Sqlite*` twin discipline is being honoured at the schema layer.
2. **Type discipline is strong.** Both `tsc --noEmit` runs are clean across ~114k lines of TypeScript.
   Every lint failure is formatting, not types.
3. **RLS hardening is unusually well documented.** `20260929_rls_nullif_guard_license_platform.sql`
   records the exact live failure it fixes (`22P02 invalid input syntax for type uuid`, observed on
   `GET /license-admin/licenses`, `GET /api/setup/status`, and startup `detachOrphanBakedLicenses`).
   That is the documentation standard the rest of the migration set should meet.
4. **`vitest.config.ts` deliberately imports from `vite`, not `vitest/config`**, so Knip can load the
   file without tripping on the ESM-only export. Non-obvious but correct — preserve it.
5. **`CLAUDE.md`'s "Known open issues" section is stale in four places.** It says CI's
   migration/schema step fails with "No test files found" (true — but the cause is the include glob,
   not the step itself, and that step is not the only one affected); that SyncConflicts has "the same
   mistake" (true — both are F-001); that audit reports 14/10 vulnerabilities (now 0 in the production
   profile); and it does not mention the 245 lint errors at all, describing only the 50 warnings.

---

## 7. SUBAGENT FINDINGS — VERIFIED AND CORRECTED

Seven subsystem audits were dispatched. Three of the nine groups were killed by the provider's
fair-share rate limit (`HTTP 429`) *after* completing their reads but *before* emitting findings; those
groups' work was re-done by the lead auditor (group G in §2–§6) or salvaged from the agents' transcripts.
The audits that did complete are recorded here — **with the lead auditor having re-verified each
material claim at the cited line before it entered this report.**

### 7.1 Claims DISPROVED by lead-auditor verification (subagent self-reports are not evidence)

The completed subagents were working against an older tree state and against their own inference. Three
of their load-bearing claims do not survive contact with HEAD `2b9b602c`:

| Claim | Verdict | Verification |
|---|---|---|
| "Google Drive: `google_access_token` has **zero callers** anywhere — the token bridge is entirely absent" | **DISPROVED** | `grep` over `backend/src`, `desktop/src-tauri/src`, `src` returns **3** references. `desktop/src-tauri/src/google_ipc.rs:242` defines `pub fn google_access_token(state: &GoogleState)`, called at `:292` by `push_token_to_sidecar`. The bridge exists in Rust and the backend consumes it: `server.ts:553` imports `liveDriveToken`/`liveDriveTokenAvailable`/`onLiveDriveConnected`, `:560` constructs `new DriveClient({ token: liveDriveToken })`, and `:587` runs an archive pass on connect. |
| "`useVouchers.ts:96-103` — missing `dashboard`, `party` from its invalidation set" | **DISPROVED** | `src/presentation/hooks/useVouchers.ts:95` and `:115` both call `invalidateFinancialViews(qc)`. That helper (`src/presentation/hooks/invalidateFinancialViews.ts:15-21`) already invalidates `["dashboard"]`, `["cashbox"]`, `["ledger"]`, `["profit"]`, `["statement"]`, `["party"]` and `["parties"]`, plus `void refreshParties()` at `:24`. The claim describes a defect that the called helper already prevents. |
| "3 P1 `toast.error`-on-success bugs in the inventory screens" | **DISPROVED** | `src/routes/inventory.tsx:165` sits inside a `catch` block (lines 162-171) — correct usage — and the success path at `:173` uses `toast.success`. The grep hits in `inventory_.count.tsx` (`:278,282,291,444`) and `useInventory.ts` (`:215,243,405`) are all validation or `onError` paths. No success path renders a red toast. |

### 7.2 Claim CONFIRMED and elevated

| Claim | Verdict | Verification |
|---|---|---|
| "`round2dp` is **float-based**, not scaled-integer — the prior audit's 'scaled-integer money layer' claim does not match the code" | **CONFIRMED** | `packages/shared/src/precision.ts:34-38`: `round2dp(n) { return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100; }`. This is IEEE-754 float arithmetic with post-hoc rounding. `is2dp` (`:11-13`) and `hasMoreThan2dp` (`:30-32`) are likewise float comparisons. The file's own header (`:1-9`) states "DB stores … bigint whole units for money", so storage *is* integer — but the arithmetic layer is float, exactly as claimed. A code comment at `:35-36` explicitly defers the change: "Preserve the established project rounding behavior until an explicit business decision approves a decimal-string/SQL-aligned replacement." |

### F-008 — The money arithmetic layer is IEEE-754 float, not scaled-integer
- **location:** `packages/shared/src/precision.ts`
- **file:** `packages/shared/src/precision.ts:34-38`
- **type:** data integrity
- **severity:** **Medium** (bounded in practice by the 2dp rounding; a real risk on large SYP sums)
- **evidence:**

```ts
// packages/shared/src/precision.ts:34-38
export function round2dp(n: number): number {
  // Preserve the established project rounding behavior until an explicit
  // business decision approves a decimal-string/SQL-aligned replacement.
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
```

- **actual:** money arithmetic is JS float with a single rounding at the end. Storage is
  scaled-integer (`bigint` whole units, per the file header at `:1-9` and the `numeric(p,s,{mode:"number"})`
  schema declarations), so the defect is confined to the arithmetic layer. SYP amounts routinely reach
  10^9–10^10; `Number.MAX_SAFE_INTEGER` is ~9.007×10^15, so a sum of individual SYP line amounts in the
  10^10 range with 2dp is still inside safe-integer territory, but intermediate products (quantity × unit
  price, then × exchange rate) can cross it.
- **expected:** either scaled-integer arithmetic end to end, or decimal-string arithmetic, so no
  intermediate product is ever represented as a float.
- **affected:** every monetary computation that routes through `round2dp`, `round4dp`, `is2dp`,
  `hasMoreThan2dp` — i.e. the whole shared money layer, both engines.
- **confidence:** **Confirmed** for the implementation (read directly). The *magnitude* of drift on real
  data is **NOT VERIFIED** — no calculation was run against production amounts.
- **remediation risk:** changing the rounding is explicitly gated by an owner decision in the source
  comment; it would alter every total in the system and must be reconciled against `ledger_entries`.
  Do not change this without that decision.

### 7.3 Completed audits recorded as scoped-but-unmerged

The following completed subagent audits are on record with their own verbatim summaries preserved in
the lead auditor's scratch directory (`harvest/`). Their claims were **not** individually re-verified
and therefore appear here as leads, not findings:

| Subsystem | Result summary | Re-verified? |
|---|---|---|
| Frontend (`src/`, 9 scope items) | All loading/error states, double-submit guards and a11y attributes checked; `login.tsx` has no `isError` but `UserPickerPage.tsx:101` owns the error state and renders it at `:426,:484,:622` | Partially — the 3 headline claims disproved (§7.1) |
| Security / auth / tenancy / deps | `openLoopback` super-admin (F-04) verified **resolved**; PostgreSQL down so RLS assessed statically only | No — lead-auditor RLS work is in §4 instead |
| Database layer | PG 103 journal entries / 103 `.sql`, SQLite 6 / 6 — **independently confirms F-005** | **Yes** — matches the lead auditor's own counts exactly |
| Sync engine | 22 sync test files executed; `master-delete-tombstone-atomicity` 1 passed | No |
| Google Drive | Drive test suite 59 passed across 6 files; the ledger's per-file counts are wrong (coordinator 6, upload-queue 9, not swapped) | Partially — token-bridge claim disproved (§7.1) |
| Tests & CI | Backend integration 156 files, SQLite twin 25, frontend 74, plus script gates | Partially — the CI defects are independently proven in F-001 |
| Desktop / Tauri | Supervisor poll 2s, `MAX_RESTARTS=3` per 5-min window, backoff `0,2,4,8,15s`, readiness ceiling 300s | No |
| Peripheral / backup | Backup v3 pipeline 2,076 LOC across 9 files; staged VERIFY→SAFETY_BACKUP→EXTRACT→MIGRATE→VERIFY→SWAP | No |

**Coverage consequence:** the frontend, sync, Drive, Tauri and backup subsystems have been *read* by a
competent auditor but their claims are not yet individually grounded. They are marked **Partial** in
the coverage matrix (§9) and are the first thing to re-verify in a follow-up session.

---

## 8. PRIORITIZED REMEDIATION PLAN

Ordered by (severity × confidence × cost). Nothing here has been applied — this audit changed no code.

| # | Finding | Action | Depends on | Regression test |
|---|---|---|---|---|
| 1 | **F-001** CI steps run zero tests | Change `.github/workflows/ci.yml:55` to `cd backend && npx vitest run tests/migrations-journal-guard.test.ts tests/schema-migration-parity.test.ts`; move line 98's second command above its `cd backend` or into its own step | nothing | A CI step asserting `No test files found` is absent from output |
| 2 | **F-004** FORCE-RLS sweeps nullable-tenant_id tables | Replace the name-based `c.relname <> 'revoked_tokens'` exemption with a structural one (`AND a.attnotnull`) or an explicit platform-table allow-list; add a `platform_or_tenant` policy for `sync_state` | owner decision on which tables are platform-managed | Migration-time assertion, run as the app role, that every FORCE-RLS table has ≥1 policy |
| 3 | **F-002** lint exits 1 (245 errors) | `npx prettier --write` in a dedicated formatting commit; re-run `npm run lint` to exit 0 | nothing (but see regression risk) | `npm run lint` exit 0 |
| 4 | **F-006** money passed through `REAL` | Decide whether any live database was migrated through 0024; if so, reconcile against `ledger_entries` before any repair | **owner decision** + a production data inspection | Row-level reconciliation report, not a test |
| 5 | **F-008** float money arithmetic | Owner decision required — the source comment gates it explicitly | owner decision | Property test over large SYP sums comparing float vs scaled-integer |
| 6 | **F-007** 12 subsystems with no subsystem-named test | Content-level audit of each subsystem; add subsystem-named test files where genuinely uncovered | nothing | New test files |

**Do not do without an explicit owner decision:** F-004's table classification (it determines which
tables the platform role can read), F-006's data migration (it touches financial history), and F-008's
rounding change (it alters every total in the system).

---

## 9. COVERAGE MATRIX

Per the mission brief, each item is marked **Complete / Partial / Not Tested / Blocked** with a reason.
No percentage is offered as proof of quality — the numerator and denominator are the rows below.

### 9.1 Frontend routes (53 files)

| Group | Routes | Inventoried | Fields/actions inspected | Data flow traced | Tests run | Verdict |
|---|---|---|---|---|---|---|
| A — invoices ×6, returns ×3, orders ×3 | 13 | ✅ | Partial (agent read; lead auditor did not re-verify) | Partial | ❌ | **Partial** |
| B — receipts, payments, cashbox, expenses, ledger, customers, suppliers, inventory, root/login | 19 | ✅ | Partial (same caveat) | Partial | ❌ | **Partial** |
| C — settings ×13, reports ×3, print-center, closing | 18 | ✅ | Partial (same caveat) | Partial | ❌ | **Partial** |

**Reason for Partial:** three subagents read these routes and reported, but the provider rate limit
killed the dispatches before their findings could be independently grounded, and the lead auditor
verified only the three load-bearing claims in §7.1 — all three of which were **disproved**. A field-by-
field pass over ~14.4k lines of route code remains genuinely undone.

### 9.2 Backend routes (~270 endpoint registrations, 32 modules)

| Group | Modules | Read | Findings verified | Tests run | Verdict |
|---|---|---|---|---|---|
| D — auth, users, party, invoice, return, order | 7 | Partial (agent read them; 429 before synthesis) | ❌ | ❌ | **Blocked — HTTP 429** |
| E — cashbox, expense, voucher, ledger, statement, year-closing, dashboard, reports, profit, fx | 10 | Partial (agent read ~35 files; 429 before synthesis) | ❌ | ❌ | **Blocked — HTTP 429** |
| F — sync(37), backup, drive, print, notification, settings, setup, integrity, desktopRuntime, license, search, audit, company | 13 | ✅ by subagent | No | No | **Partial** |
| G — database, schema parity, migrations, RLS, CI, tests, deps | — | ✅ lead auditor | **Yes** | Partial | **Complete** |

### 9.3 Quality gates and test suites

| Item | Verdict | Reason |
|---|---|---|
| `npx tsc --noEmit` root | **Complete** | Executed, exit 0 |
| `npx tsc --noEmit` backend | **Complete** | Executed, exit 0 |
| `npm run lint` | **Complete** | Executed, exit 1, full problem list captured |
| `npx prettier --check .` | **Complete** | Executed, 812 files |
| `npm audit` (root, prod) | **Complete** | Executed, 0 vulnerabilities |
| CI workflow correctness | **Complete** | Every step read; 2 defects proven with real exit codes |
| Schema parity (both engines) | **Complete** | Scripted comparison, 47 shared tables, 0 column differences |
| Migration journal consistency | **Complete** | Both engines resolve exactly |
| RLS structural review | **Complete** (static) | Nullable-tenant_id sweep + policy grep; runtime effect NOT VERIFIED |
| Skipped-test sweep | **Complete** | 0 markers across 4 trees |
| Frontend vitest (74 files) | **Not Tested** | ~410 MB free RAM; repo rule forbids concurrent heavy suites |
| Backend SQLite vitest (~156 files) | **Not Tested** | Same |
| `cargo test` | **Not Tested** | Same |
| `npm run typecheck:sqlite` | **Not Tested** | Same |
| Live PostgreSQL / RLS drill | **Blocked** | No database contacted; read-only audit, no credentials |
| Playwright / TesterArmy e2e | **Blocked** | Needs a live stack (18080/18081) and `E2E_ADMIN_PASSWORD` |
| Page-by-page field audit | **Not done** | See 9.1 |

### 9.4 Business-workflow tracing (mission Phase 4)

| Workflow | Traced end-to-end? | Reason |
|---|---|---|
| Invoice → ledger → statement → party balance | **No** | Group D/E blocked by 429 |
| Receipt/payment → cashbox → day close | **No** | Group E blocked by 429 |
| Inventory count → adjustment → stock movement | **No** | Group D blocked by 429 |
| Sync outbox → pull → conflict resolution | **No** | Group F read but not verified |
| Backup → restore → reconcile | **No** | Group F read but not verified |
| Money precision contract | **Partial** | `precision.ts` read and F-008 filed; call sites not traced |

**This is the largest gap in the audit.** The mission's Phase 2 (page-by-page, field-by-field) and
Phase 4 (workflow invariants) are substantially **not done**. §2–§7 cover the gates, the database and
the CI; they do not cover the ERP's business behaviour.

---

## 10. AREAS NOT FULLY EXAMINED — EXPLICIT STATEMENT

Read honestly, this audit delivers:

1. **A complete, verified architecture and inventory map** (§1) — every route, endpoint, module and
   LOC count, grounded in the tree at HEAD.
2. **A complete static-gate picture** (§2) — typecheck, lint, format, audit, and two CI defects proven
   with real exit codes.
3. **A verified database and RLS assessment** (§4) — schema parity, journal consistency, and a
   structural RLS defect with its mitigation analysed.
4. **Four confirmed defects** (F-001, F-002, F-004, F-008) with `file:line`, root cause, affected
   surface, reproduction and regression test; two positive findings (F-003, F-005) so a future audit
   does not re-flag them.

It does **not** deliver the page-by-page, field-by-field, workflow-by-workflow audit the brief asked
for. That work was attempted seven times; the provider's fair-share rate limit killed the dispatches
after they had done the reading but before they could synthesise, and three groups never recovered.
The routes and workflows listed in §9.1 and §9.4 are **unexamined at field level**, not "verified
clean."

Two further honest caveats:

- **No test suite was executed.** Not one of the ~230 test files ran. Every test-related statement in
  this report is either a static inspection (skipped-marker sweep, coverage mapping) or a subagent's
  self-report, explicitly labelled as such.
- **No database was contacted.** RLS is assessed structurally only; F-004's runtime effect and F-006's
  historical corruption are both unproven.

### Resume procedure (first unfinished item, in order)

1. Re-dispatch **group D** (auth/users/party/invoice/return/order) and **group E** (financial) as
   smaller agents — the split pattern was the right fix, it was simply rate-limited out.
2. Re-dispatch the **frontend A/B/C field-level pass** with the corrected contract: subagent
   self-reports are leads, and the three disproved claims in §7.1 are the standing example of why.
3. On a quiet machine, run one at a time with a plain `vitest run` (never `--reporter=basic`):
   `npx vitest run` → `cd backend && DB_ENGINE=sqlite npx vitest run --reporter=dot` →
   `cd desktop/src-tauri && cargo test` → `cd backend && npm run typecheck:sqlite`. Re-run `dfp029`
   standalone if it times out in the full backend run.
4. Trace the six business workflows in §9.4, starting with invoice → ledger → statement → party
   balance, and verify the statement ordering rule (`date, created_at, document-rank, id`, both cursor
   predicates, both engines).

---

## 11. LEAD-AUDITOR METHOD NOTES AND SELF-CORRECTIONS

Recorded because three of them produced false findings that were caught before publication, and the
same traps will catch the next auditor.

1. **Column-parity parsing.** The first script matched `/^\s{2}name:/` and reported 8 tables with
   phantom differences. Cause: PG indents columns 2 spaces, SQLite 4. The second pattern restricted to
   known type names and reported 39/47 tables differing — cause: PG uses `timestamp(...)`/`uuid(...)`
   while SQLite uses `timestamptz(...)`. The third pattern matched any `name: fn(` call and reported
   1 table — cause: PG's `(table) => ({ … })` callback declares **indexes**, which SQLite puts in
   `0000_baseline.sql`. Only after excluding that callback did the result become trustworthy:
   **0 column differences across 47 tables**. Verified by reading both `cashbox.table.ts` files in full.
   *Lesson: a 90%-diff result from a parser is a parser bug until proven otherwise.*
2. **Piped exit codes.** Two exploratory runs piped through `tail` reported `EXIT=0` while the process
   had exited 1. Every exit code in §2 was re-established by redirecting to a file and reading `$?`
   directly.
3. **Multi-table schema files.** `cashbox.table.ts` declares four tables in one file
   (`cashbox_sessions`, `manual_movements`, `day_closes`, `cashbox_daily_balances`). Any per-file
   column analysis must split on `export const`, not treat the file as one table.
4. **Subagent self-reports are leads, not findings.** Of the three load-bearing claims re-verified,
   all three were wrong (§7.1). The audits were competent — their reading was real — but they worked
   against an older tree state (`729fcd98`, not `2b9b602c`) and inferred beyond their evidence. Every
   claim that entered this report as a finding was re-read at its cited line by the lead auditor.

---

## 12. GROUP D COMPLETED BY LEAD AUDITOR (backend auth/users/parties/invoices/returns/orders)

Dispatched twice, killed twice by the provider's fair-share rate limit (`HTTP 429`) — the second
attempt reached 21 API calls and completed its whole read phase (all five route files, all three
schema files, all three use-case files, and real `diff -u` runs of each PG repository against its
SQLite twin) before dying at the synthesis step. The salvageable parts were completed by the lead
auditor directly.

### 12.1 Engine parity — VERIFIED CLEAN across all 37 repository twins

The lead auditor ran a semantic-difference extractor over every `Postgres*Repository.ts` /
`sqlite/Sqlite*Repository.ts` pair, normalising away imports, comments, `PORTED-FROM` headers and
whitespace, then comparing the signals that actually carry behaviour: every `assert*` call,
`record*`/`compute*`/`notify*` call, every `runInTransaction`/`withTenantTx`/`sqliteDb`/
`sqliteIndependentDb` call, every `orderBy(...)`, every `.limit(...)`, every `round2dp`/`round4dp`/
`normalizeMoney2dp`, every idempotency reference, and every keyset helper
(`cursorColumns`, `afterCursor`, `keysetOrder`, `nextCursorOf`, `decodeCursor`).

```
repositories with signal divergence: 0 / 37
```

**F-009 — The two-engine twin discipline holds at the repository layer**
- **type:** informational (positive finding)
- **severity:** Informational
- **evidence:** 0 of 37 repository pairs diverge on any behavioural signal. Raw line counts differ by
  29–87 lines per pair, but every difference is import style, comment/header text, or drizzle dialect
  syntax (`ilike` vs `like`, `sql` fragments) — not logic.
- **confidence:** **Confirmed** — scripted over all 37 pairs. Caveat: this proves the *same functions
  are called*; it does not prove their bodies are byte-identical, so a logic change inside a shared
  helper would not surface here.

### 12.2 Statement ordering — VERIFIED CORRECT on both engines

The repo's documented rule is `date, created_at, document-rank, id`, with ORDER BY and both cursor
predicates in step on both engines. Verified directly:

```
PostgresStatementRepository.ts:239   .orderBy(asc(date), asc(createdAt), asc(docRank), asc(id))
PostgresStatementRepository.ts:298   .orderBy(asc(date), asc(createdAt), asc(docRank), asc(id))
SqliteStatementRepository.ts:243     .orderBy(asc(date), asc(createdAt), asc(docRank), asc(id))
SqliteStatementRepository.ts:303     .orderBy(asc(date), asc(createdAt), asc(docRank), asc(id))
```

Both engines, both query paths, identical four-column ordering. No finding.

### 12.3 CONFIRMED DEFECT — `POST /orders` does not require an Idempotency-Key

**F-010 — `POST /orders` accepts a financial mutation with no idempotency key**
- **location:** `backend/src/presentation/routes/order.route.ts`
- **file:** `backend/src/presentation/routes/order.route.ts:61`
- **type:** data integrity / reliability
- **severity:** **Medium**
- **evidence:**

```ts
// order.route.ts:57-62
router.post(
  "/orders",
  auth,
  writeGuard,
  idempotency("POST"),              // <-- no { required: true }
  validateBody(createOrderSchema),
```

The middleware's contract, read from its own source:

```ts
// idempotency-handler.middleware.ts:17-18
 * REPAIR-008: pass `{ required: true }` on financial mutations so a missing
 * key yields HTTP 428 `IDEMPOTENCY_KEY_REQUIRED`.
```

Every other financial POST in the codebase passes the flag:

| Route | Call | Required? |
|---|---|---|
| `invoice.route.ts:61` | `idempotency("POST", { required: true })` | ✅ |
| `invoice.route.ts` (PUT) | `idempotency("PUT", { required: true })` | ✅ |
| `return.route.ts:54` | `idempotency("POST", { required: true })` | ✅ |
| `voucher.route.ts:107,116` | `idempotency("POST", { required: true })` | ✅ |
| `cashbox.route.ts:130,181` | `idempotency("POST", { required: true })` | ✅ |
| `expense.route.ts:43` | `idempotency("POST", { required: true })` | ✅ |
| `ledger.route.ts:201` | `idempotency("POST", { required: true })` | ✅ |
| `statement.route.ts:117,218` | `idempotency("POST", { required: true })` | ✅ |
| `party.route.ts:520` | `idempotency("POST", { required: true })` | ✅ |
| **`order.route.ts:61`** | **`idempotency("POST")`** | ❌ **MISSING** |

- **actual:** `POST /orders` creates an order **and** its sync-outbox unit in one transaction
  (`order.route.ts:68-71`: "the order and its outbox unit share ONE transaction", and the code is
  minted inside the repository transaction from the device's reserved block). A request with no
  `Idempotency-Key` header is accepted. A retried POST — network timeout where the response was lost
  but the write committed, or a user double-tapping submit — creates a **second order** and a second
  outbox unit. The order code is minted from the device's reserved block, so the duplicate is *not*
  prevented by a unique constraint on the number: it simply consumes the next number in the block.
- **expected:** `idempotency("POST", { required: true })`, matching every sibling financial POST and
  the middleware's own documented contract at `:17-18`.
- **affected:** `POST /orders` only. All nine other financial mutations already enforce the rule, so
  this is a single-route gap, not a systemic one.
- **downstream_effects:** duplicate orders → duplicated stock commitments and duplicated sync-outbox
  units that propagate to the hub and to other devices. The repo's money-mutation rules are
  otherwise uniformly enforced, so this route is the outlier.
- **reproduction:** `curl -X POST /api/orders` with a valid body and **no** `Idempotency-Key` header →
  expect 428 `IDEMPOTENCY_KEY_REQUIRED`, observe 201 instead. Send the same request twice with the
  same key → both succeed rather than the second returning the cached response.
- **existing_test_coverage:** unknown — no test asserting 428 on `POST /orders` was located.
- **recommended_fix:** change `order.route.ts:61` to `idempotency("POST", { required: true })`.
- **regression_risk:** **real but bounded** — any client that currently POSTs an order without a key
  will start receiving 428. Audit the frontend order-creation path
  (`src/routes/orders.new.tsx` and the order API client in `src/infrastructure/`) for key generation
  before deploying the change. Every other financial route already requires the key, so the client
  almost certainly sends one; verify rather than assume.
- **regression_test:** an integration test that POSTs `/orders` without a key and asserts 428, plus a
  test that two POSTs with the same key produce exactly one order.
- **confidence:** **Confirmed** — read directly at `order.route.ts:61` and compared against nine
  sibling routes in the same call style.

### 12.4 Group D coverage after this pass

| Sub-area | Verdict |
|---|---|
| Engine parity (invoice/return/order/party + 33 more repos) | **Complete** — F-009 |
| Statement ordering rule | **Complete** — verified both engines |
| Idempotency enforcement on financial POSTs | **Complete** — F-010 |
| RBAC on auth/user/party/invoice/return/order routes | **Not done** — the rate limit killed this before it began |
| Zod schema vs handler field agreement | **Not done** |
| Tenant scoping in these use-cases | **Not done** |
| auth internals (JwtSigner, PasswordHasher, TokenDenylist, sessionCutoff) | Read by the failed agent, **not verified** by the lead auditor |

---

## 13. FRONTEND GROUP A — PARTIAL AUDIT BY LEAD AUDITOR (invoices ×6, returns ×3, orders ×3)

Dispatched once, killed by the provider's fair-share rate limit (`HTTP 429`) at 839s. Notably, the agent
**did read its entire scope first** — all 13 route files, the shared form components
(`FormField.tsx`, `InvoiceFormLayout.tsx`, `SaleLineCard.tsx`, `ReturnForm.tsx`), the hooks
(`useInvoices.ts`, `useOrders.ts`, `useReturns.ts`, `usePrintJobs.ts`, `useCustomerCredit.ts`), the type
modules and `precision.ts` — before dying at the synthesis step. The lead auditor re-ran the checks with
the highest defect yield on form pages and verified each result at source.

### 13.1 Checks run and their results

| Check | Scope | Result |
|---|---|---|
| Backend schema field inventory | invoice/return/order `.schema.ts` | `order.schema.ts` parses (31 fields); the invoice and return schemas are **re-exports of `@erp/shared`**, so their fields live in `packages/shared` — the same pattern already noted for `party.schema.ts` |
| Label/control association | 13 routes | **1 defect** (F-011) |
| Double-submit guards | 13 routes | No defect — see 13.3 |
| Financial cache invalidation | 4 hooks | **No defect** — see 13.2 |
| Toast success/error misuse | 13 routes | **No defect** — verified, see 13.3 |
| Money formatting via shared helpers | 13 routes | **No defect** — zero `toFixed(` in any invoice/return/order route |
| Clickable non-interactive elements | 13 routes | **No defect** — zero `onClick` on `div`/`tr` in any of the 13 routes |

### 13.2 Cache invalidation — VERIFIED CORRECT

The four invoice/order/voucher/return hooks all invalidate financial views on every mutation:

```
useInvoices.ts   useMutation=3  invalidateFinancialViews=5  invalidateQueries=9
useOrders.ts     useMutation=3  invalidateFinancialViews=5  invalidateQueries=6
useVouchers.ts   useMutation=3  invalidateFinancialViews=5  invalidateQueries=3
useReturns.ts    useMutation=2  invalidateFinancialViews=4  invalidateQueries=4
```

Every mutation in these hooks calls `invalidateFinancialViews(qc)`, which (per
`src/presentation/hooks/invalidateFinancialViews.ts:15-26`) covers `dashboard`, `cashbox`, `ledger`,
`profit`, `statement`, `party`, `parties` and `invoices`, plus `void refreshParties()`. This
independently confirms the disproof recorded in §7.1 — the earlier subagent claim of missing
`dashboard`/`party` invalidation does not hold.

### 13.3 Two suspected defects investigated and CLEARED

**`toast.error` in `returns.index.tsx`** — a grep showed `success=0 error=1`, which would violate the
repo rule that success messages use `toast.success`. Verified at source: `returns.index.tsx:38-45`
wraps `printDocument(...)` in `try/catch` and the `toast.error` at `:44` is the **catch** branch
("failed to prepare the document for printing"). Correct usage. The route has no success toast because
printing is fire-and-forget, not because a success path renders red.

**Raw `<label>` elements in two routes** — `invoices.entry.new.tsx:1039` and
`invoices.sale.new.tsx:832,949` contain bare `<label>` tags with no `htmlFor`. Verified: both wrap a
`<input type="checkbox">` whose label text is inside the element, which is valid and accessible
(implicit association). Not a defect. The *systemic* label problem is F-011 below.

### 13.4 CONFIRMED DEFECT — `HeaderField` does not tie its label to its control

**F-011 — `HeaderField` renders a label with no `htmlFor`, breaking label/control association on the invoice forms**
- **location:** `src/components/invoices/InvoiceFormLayout.tsx`
- **file:** `src/components/invoices/InvoiceFormLayout.tsx:118-127`
- **type:** accessibility
- **severity:** **Low** (real, but no data or correctness impact)
- **evidence:**

```tsx
// src/components/invoices/InvoiceFormLayout.tsx:118-127
export function HeaderField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
```

The underlying `Label` is Radix-based and **does** forward arbitrary props including `htmlFor`
(`src/components/ui/label.tsx` spreads `{...props}` onto `LabelPrimitive.Root`) — so the capability
exists and is simply not used. Compare the repo's own documented rule (`CLAUDE.md` → "Form fields"):
"use `FormField` (`src/components/common/FormField.tsx`) so the label is tied to its control
(`htmlFor`/`useId`); a `Select` passes `htmlFor` and puts the id on its `SelectTrigger`."

Usage: `invoices.sale.new.tsx` has **8** `<HeaderField>` instances, `invoices.entry.new.tsx` has **6** —
14 labelled header fields with no programmatic association.

- **actual:** the label is a sibling `<div>`, not associated with its input. A screen reader announces
  the input with no name, and clicking the label does not focus the control.
- **expected:** either `HeaderField` accepts and forwards an `htmlFor`, or these fields use `FormField`
  as the repo rule requires.
- **affected:** `src/components/invoices/InvoiceFormLayout.tsx:118` (the component);
  `src/routes/invoices.sale.new.tsx` (8 uses), `src/routes/invoices.entry.new.tsx` (6 uses).
  `CardField` at `:129-` in the same file should be checked for the same pattern — it was not verified.
- **downstream_effects:** accessibility only. Arabic RTL forms with 14 unlabelled inputs is a real
  usability barrier for screen-reader users; no data-integrity consequence.
- **reproduction:** open a new sale invoice, inspect any header field — the `<label>` has no `for`
  attribute and the sibling `<input>`/`<select>` has no matching `id`.
- **existing_test_coverage:** none found.
- **recommended_fix:** add an optional `htmlFor` prop to `HeaderField` and pass it at all 14 call sites,
  or migrate them to `FormField`.
- **regression_risk:** low. `CardField` and the two raw `<label>` cases should be checked in the same
  pass so the fix is complete rather than partial.
- **regression_test:** a component test asserting every `HeaderField` renders a `<label for>` matching
  its child control's `id`.
- **confidence:** **Confirmed** — the component and all 14 call sites were read directly.

### 13.5 Group A coverage after this pass

| Sub-area | Verdict |
|---|---|
| Label/control association | **Complete** — F-011 |
| Financial cache invalidation | **Complete** — verified correct |
| Toast success/error usage | **Complete** — verified correct |
| Ad-hoc money rounding (`toFixed`) | **Complete** — zero occurrences |
| Clickable non-interactive elements | **Complete** — zero occurrences |
| Payload vs Zod-schema field agreement | **Not done** — the invoice/return schemas are `@erp/shared` re-exports and were not diffed against the request bodies |
| Field-level validation vs backend rules | **Not done** |
| Loading / empty / error states per page | **Not done** |
| Pagination, totals and statement ordering in list views | **Not done** |
| RTL layout and keyboard interaction per field | **Not done** |

The mission's Phase 2 requirement — "for EVERY page, inspect every relevant UI element… every input
field, label, placeholder, default value, required rule, validation rule, and error state" — remains
**substantially incomplete** for these 13 routes (~5,900 lines). §13 covers the six highest-yield
systematic checks and nothing more.

---

## 14. GROUP D1 COMPLETED BY LEAD AUDITOR (auth, users, parties)

The D1 dispatch failed twice on `HTTP 429` (107s and again on retry). Rather than spend a third
dispatch on a rate-limited provider, the lead auditor ran the D1 security checks directly. All results
below were read from source at HEAD `2b9b602c`.

### 14.1 CONFIRMED DEFECT — password reset has no PIN-strength policy, and the password floor is weak

**F-012 — `POST /users/:id/reset-password` enforces only a 6-character minimum and bypasses the PIN-strength rule**
- **location:** `backend/src/presentation/routes/user.route.ts`
- **file:** `backend/src/presentation/routes/user.route.ts:34` and `:183-197`
- **type:** security issue
- **severity:** **Medium**
- **evidence:**

```ts
// user.route.ts:34 — the reset-password body schema
  password: z.string().min(6).max(128),
```
```ts
// user.route.ts:183-197
  // POST /users/:id/reset-password — Reset user password
  router.post(
    "/users/:id/reset-password",
    ...
    const { password } = body<{ password: string }>(req);
    const passwordHash = await passwordHasher.hash(password);
    const result = await userRepo.update(id, { passwordHash }, adminCtx);
```

The repo has a dedicated PIN-strength rule that is enforced **everywhere else**:

```ts
// auth.schema.ts:33
    .refine((pin) => !isWeakPin(pin), { ... });
// setupUseCases.ts:620
  if (parsed.data.pin && isWeakPin(parsed.data.pin)) { ... }
```

- **actual:** an admin can reset any user's password to any 6-character string, including
  `isWeakPin`-rejected values. The two paths that *do* check (`auth.schema.ts:33` for login/PIN change,
  `setupUseCases.ts:620` for the setup wizard) are not on this code path, so the rule is bypassable by
  choosing a different endpoint.
- **expected:** the reset path applies the same `isWeakPin` / minimum-length policy as the other
  credential-setting paths, or a documented reason it need not.
- **affected:** `backend/src/presentation/routes/user.route.ts:34` (schema) and `:183-197` (handler).
  RBAC is correct here — `registerUserRoutes` is registered with `rbac(["admin"])`
  (`server.ts:299-306`), so only admins reach it. The defect is policy bypass, not missing
  authorization.
- **downstream_effects:** an admin-set weak credential survives every other guard in the system. This
  is the classic "the rule exists but one door doesn't check it" pattern.
- **reproduction:** as an admin, `POST /api/users/<id>/reset-password` with
  `{"password":"111111"}` → 200. The same value submitted to the PIN-change path is rejected by the
  `isWeakPin` refine at `auth.schema.ts:33`.
- **existing_test_coverage:** none found for this route.
- **recommended_fix:** apply the same `isWeakPin` refine (or an equivalent strength rule) to the
  reset-password schema at `user.route.ts:34`.
- **regression_risk:** low — any client currently setting a 6-char password that happens to be
  "weak" would start receiving 422. Given the desktop UI is a PIN picker, real PINs are already
  subject to the stricter rule elsewhere.
- **regression_test:** a test asserting `POST /users/:id/reset-password` rejects a weak password with 422.
- **confidence:** **Confirmed** — schema, handler, the two enforcing call sites, and the RBAC
  registration were all read directly.

### 14.2 Auth subsystem checks — VERIFIED SOUND (no findings)

| Property | Evidence | Verdict |
|---|---|---|
| Login rate limiting | `auth.route.ts:43-45` — `rateLimit({ windowMs: 15*60*1000, max: 5 })` | ✅ Present |
| Refresh reuse detection | `auth.route.ts:342-347` — a refresh token already in the denylist returns 401 and logs `refresh reuse detected` | ✅ Present |
| Single-use rotation | `auth.route.ts:380-382` — "Rotation is single-use: retire the presented refresh token", preventing replay of a captured copy within the 365-day window | ✅ Present |
| Invalid refresh → 401 not 500 | `auth.route.ts:326-327` | ✅ Present |
| Session cutoff enforced on refresh | `auth.route.ts:355-358` — `isTokenBeforeCutoff(payload.iat, ident.tokensRevokedBefore)` → `SESSION_REVOKED` | ✅ Present |
| License gate on refresh | `auth.route.ts:360-364` — `assertTenantLicenseAllowsAccess` before minting a new pair | ✅ Present |
| Logout revokes the refresh token | `auth.route.ts:418-430` — verifies and denylists the body's refresh token | ✅ Present |
| RBAC on party routes | `server.ts:290-297` — writes `rbac(["admin","accountant"])`, reads `rbac(["admin","accountant","warehouse","viewer"])` | ✅ Correct split |
| RBAC on user routes | `server.ts:299-306` — `rbac(["admin"])` throughout | ✅ Correct |
| Error handler does not leak internals | `error-handler.middleware.ts` — `ValidationError`→422 with details, `AuthError`→401/403 with code only, `DomainError`→mapped status with code only, and the unhandled branch returns a **generic Arabic message** (`"حدث خطأ داخلي. يرجى المحاولة لاحقاً."`) with the real error going to the logger only | ✅ No stack trace, SQL text or PII reaches the client |

### 14.3 Group D coverage after this pass

| Sub-area | Verdict |
|---|---|
| Engine parity across repository twins | **Complete** — F-009 (§12.1) |
| Statement ordering rule, both engines | **Complete** — verified (§12.2) |
| Idempotency enforcement on financial POSTs | **Complete** — F-010 (§12.3) |
| Auth internals (rotation, reuse, cutoff, license, logout) | **Complete** — verified sound (§14.2) |
| RBAC on party/user/invoice/return/order routes | **Complete for party + user** (§14.2); invoice/return/order registrations not individually re-read |
| Error-handler information disclosure | **Complete** — verified sound (§14.2) |
| Credential-strength policy consistency | **Complete** — F-012 (§14.1) |
| Zod schema vs handler field agreement | **Not done** — the invoice/return schemas are `@erp/shared` re-exports; not diffed against request bodies |
| Tenant scoping inside these use-cases | **Not done** |
| Party merge / purge cascade correctness | **Not done** — the failed agent read `mergePartiesUseCase.ts` and `purgePartyCascadeUseCase.ts` but never analysed them |

---

## 15. GROUP E2 PARTIAL AUDIT BY LEAD AUDITOR (ledger, statements, year-closing, dashboard, reports, profit, fx)

The E2 dispatch failed on `HTTP 429` at 310s, after reading `ledger.route.ts`, `ledger.schema.ts`,
`ledgerUseCases.ts`, `statement.route.ts`, `statement.schema.ts`, `year-closing.route.ts`,
`financialYearRepository.ts`, and both engines' ledger/statement repositories. The lead auditor ran the
money-critical checks directly.

### 15.1 Ledger append-only enforcement — VERIFIED SOUND on the cancel path

The repo rule is that the ledger is append-only and reversals are written as status changes. The
trigger is `backend/src/infrastructure/orm/migrations/0013_db_hardening.sql:13-49`:

```sql
CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only() ...
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
      USING ERRCODE = 'insufficient_privilege';
  -- Allow UPDATE only for cancellation: status → 'cancelled' with cancelled_at set
  IF NEW.status <> 'cancelled' THEN RAISE EXCEPTION ... END IF;
  -- Prevent changes to financial columns even during cancellation
  IF NEW.debit <> OLD.debit OR NEW.credit <> OLD.credit OR ... THEN RAISE EXCEPTION ... END IF;
```

A grep found 22 `update(ledgerEntries)` / `delete(ledgerEntries)` calls in application code. Each was
checked against the trigger's rules:

- **21 are legitimate cancellations.** Example — `PostgresCashboxRepository.ts:168-186`:

```ts
async deleteManualMovement(id: UUID, ctx: TenantContext): Promise<void> {
  return this.db.transaction(async (tx) => {
    // Reverse the accounting trace: cancel the linked ledger row (append-only
    // trigger allows only status → 'cancelled').
    await tx.update(ledgerEntries).set({
      status: "cancelled", cancelledAt: new Date(), cancelledBy: ctx.userId,
    })...
```

These set only `status`/`cancelled_at`/`cancelled_by` — exactly the columns the trigger permits —
and financial columns are untouched. The same pattern holds in `PostgresExpenseRepository.ts:230`,
`PostgresInvoiceRepository.ts:1115,1489,1506,1525`, `PostgresPartyRepository.ts:144,564`,
`PostgresReturnRepository.ts:752`.

- **1 is a hard DELETE** — see F-013.

### 15.2 CONFIRMED DEFECT — the dye-purge hard-deletes ledger rows on PostgreSQL, where the trigger forbids it

**F-013 — `dyePurgeRepository.ts:494` DELETEs `ledger_entries`, which the append-only trigger rejects on the hub engine**
- **location:** `backend/src/infrastructure/repositories/dyePurgeRepository.ts`
- **file:** `backend/src/infrastructure/repositories/dyePurgeRepository.ts:492-497`
- **type:** data integrity / functional defect
- **severity:** **High** (PostgreSQL only — the desktop engine is unaffected)
- **evidence:**

```ts
// dyePurgeRepository.ts:488-497
    // 2. journal entries for those documents — invoice-keyed legs AND the
    //    voucher-keyed cash legs, which are keyed by voucher id (see Scope).
    //    Same predicate the impact sheet counted with, so the two cannot drift.
    const ledgerPred = scopedLedgerPredicate(scope.invoiceIds, scope.voucherIds);
    const deletedLedger = ledgerPred
      ? await tx
          .delete(ledgerEntries)                                   // <-- hard DELETE
          .where(and(eq(ledgerEntries.tenantId, tenantId), ledgerPred))
          .returning({ id: ledgerEntries.id })
      : [];
```

Against it, the PostgreSQL trigger:

```sql
-- 0013_db_hardening.sql:16-19
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
      USING ERRCODE = 'insufficient_privilege';
```

**The SQLite engine handles this correctly and the PostgreSQL one does not.** The engine dispatch is
explicit in `engineHelpers.ts:24-25`:

```ts
export const dyePurgeHelpers = () =>
  pick<DyePurge>(
    () => import("./sqlite/helpers/dyePurgeRepository.js"),   // SQLite twin
    () => import("./dyePurgeRepository.js"),                 // PostgreSQL
  );
```

The SQLite twin calls an explicit, documented escape hatch before its DELETE:

```ts
// sqlite/helpers/dyePurgeRepository.ts:489,505
  await allowDyePurge(tx);
  ... .delete(ledgerEntries)
```
```ts
// orm/sqlite/transaction.ts:229-232
/** Dye purge: allow ledger DELETE only (UPDATE stays guarded), for the rest of this transaction. */
export async function allowDyePurge(_tx: unknown): Promise<void> {
  setFlag("allow_dye_purge");
}
```

A grep across **all** PostgreSQL migrations for `allow_dye_purge`, `DISABLE TRIGGER`,
`session_replication_role` or any equivalent returns **0 matches**. There is no PostgreSQL counterpart.

- **actual:** on the hub engine, any dye purge that has ledger rows in scope raises
  `insufficient_privilege: ledger_entries is append-only: DELETE not allowed`. The whole purge
  transaction rolls back. On the desktop (SQLite) engine the same operation succeeds.
- **expected:** either the PostgreSQL path cancels the ledger rows (`status → 'cancelled'`, which the
  trigger permits and which every other repository already does), or it has a documented,
  trigger-aware escape hatch matching the SQLite twin's `allowDyePurge`.
- **affected:** `backend/src/infrastructure/repositories/dyePurgeRepository.ts:492-497`; reachable via
  `dye.route.ts:92` → `dyePurgeHelpers()`. **PostgreSQL only** — SQLite is correct.
- **downstream_effects:** the purge feature is non-functional on the hub, and it fails *late* — after
  `computeDyePurgeImpact` has already counted the rows it intends to delete (`dye.route.ts:62`), so the
  impact sheet shown to the user promises a deletion that cannot complete.
- **reproduction:** on a PostgreSQL-backed install with a dye that has invoices/returns/vouchers
  (therefore ledger rows) in scope, run the purge → `insufficient_privilege`. On SQLite the same purge
  succeeds. **NOT VERIFIED live** — no PostgreSQL database was contacted during this audit.
- **existing_test_coverage:** the backend suite runs on SQLite by default (`npm run test:sqlite`), so
  any existing purge test exercises the *working* engine. This is precisely the class of defect the
  SQLite-default test setup cannot catch.
- **recommended_fix:** mirror the cancel pattern used everywhere else — replace the DELETE with a
  scoped `status → 'cancelled'` update — or add a PostgreSQL equivalent of `allowDyePurge`.
- **regression_risk:** changing DELETE to cancel leaves the rows in place, so any downstream count of
  "purged" rows or any test asserting the rows are gone must be updated. Reconciliation against
  `ledger_entries` is required.
- **regression_test:** a PostgreSQL-engine purge test asserting the operation succeeds and the ledger
  rows end `status = 'cancelled'`. This test must run against PostgreSQL, not only SQLite.
- **confidence:** **Confirmed** for the code and the trigger (both read directly, and the SQLite/PG
  asymmetry is explicit in `engineHelpers.ts`). **NOT VERIFIED** at runtime — no live PostgreSQL.

### 15.3 Statement ordering — VERIFIED CORRECT

Already established in §12.2: both engines use
`orderBy(asc(date), asc(createdAt), asc(docRank), asc(id))` at `PostgresStatementRepository.ts:239,298`
and `SqliteStatementRepository.ts:243,303`, matching the documented rule exactly. Neither repository
uses `afterCursor`/`cursorColumns` — pagination is offset-based via `.limit()`, so there is no
cursor-predicate drift to check. No finding.

### 15.4 Group E2 coverage after this pass

| Sub-area | Verdict |
|---|---|
| Ledger append-only enforcement (trigger rules vs 22 call sites) | **Complete** — 21 legitimate, F-013 |
| Engine parity of the dye purge | **Complete** — F-013 |
| Statement ordering, both engines | **Complete** — verified correct |
| Money precision in ledger/statement writes | **Not done** |
| Year-closing double-run / closed-period writes | **Not done** — the agent read `year-closing.route.ts` and `financialYearRepository.ts` but never analysed them |
| Dashboard/report totals vs ledger agreement | **Not done** |
| FX reference-rate direction and cache expiry | **Not done** |
| Statement balance consistency (list vs detail) | **Not done** |
| `syncCoverage.ts` completeness for these routes | **Not done** |
| Group E1 (cashbox, expenses, vouchers) | **Not attempted** — that dispatch also died on `HTTP 429` |

---

## 16. FRONTEND GROUP B — PARTIAL AUDIT BY LEAD AUDITOR (receipts, payments, cashbox, expenses, ledger, parties, inventory, root/login)

The group B dispatch failed on `HTTP 429` at 939s — the longest-lived attempt, having read all 19 route
files plus `FormField.tsx`, `PartyCombobox.tsx`, `InvoiceFormLayout.tsx` and
`inventoryCountRepository.ts`. The lead auditor re-ran the eight highest-yield systematic checks over
the same file set and verified each signal at source.

### 16.1 Results of the eight checks

| # | Check | Result |
|---|---|---|
| 1 | Label/control association | 3 raw `<label>` — all verified non-defects (16.2) |
| 2 | USD/SYP currency mixing | **No defect** — verified correct (16.3) |
| 3 | Double-submit guards | **No defect** — 0 unguarded mutations |
| 4 | Cache invalidation on financial hooks | **No defect** — verified correct (16.4) |
| 5 | Per-route `invalidateFinancialViews` | **No defect** — 0 routes with mutations lacking it |
| 6 | Ad-hoc money rounding (`toFixed`) | **No defect** — zero occurrences |
| 7 | Clickable non-interactive elements | **No defect** — zero occurrences |
| 8 | Pagination / totals in list views | Inconclusive — see 16.5 |

**No new defect was found in group B.** That is a result, not an absence of effort: eight independent
systematic checks across 19 routes (~4,900 lines) plus source verification of every signal they raised.

### 16.2 Raw `<label>` elements — investigated and CLEARED

| Location | Verdict |
|---|---|
| `expenses.new.tsx` | 6 `FormField` uses (correct), 1 raw `<label>` **with** `htmlFor` — correctly associated |
| `expenses.index.tsx` | 3 raw `<label>` — filter-bar labels; verified as implicit or decorative |
| `inventory_.count.tsx` | 2 raw `<label>` — count-entry labels |

`expenses.new.tsx` already has an `htmlFor`, so it satisfies the repo rule. Unlike group A's
`HeaderField` (F-011), which systematically drops the association across 14 call sites, these are
isolated and mostly correct. Not filed as findings.

### 16.3 Currency separation — VERIFIED CORRECT

`cashbox.tsx` references both `USD` (21×) and `SYP` (24×), which on its face is exactly the
"USD and SYP balances are never mixed" risk. Verified at source:

```tsx
// cashbox.tsx:78-82 — separate, currency-keyed queries
  const { data: balSYP = 0 } = useCashBalance(today, "SYP");
  const { data: balUSD } = useCashBalance(today, "USD");
  const { data: todayFlowSYP } = useCashMovementsOn(today, "SYP");
  const { data: todayFlowUSD } = useCashMovementsOn(today, "USD");
```
```tsx
// cashbox.tsx:191
      {/* B — Financial Summary: independent SYP / USD boxes (no FX mix) */}
```
```tsx
// cashbox.tsx:138-145 — the two currencies are never summed
    SYP: balSYP,
    USD: balUSD ?? 0,
```

Balances are queried, held and displayed per-currency with an explicit no-FX-mix comment at the render
site. `inventory_.count.tsx`'s single USD/SYP reference pair is the same pattern. The repo rule holds.

### 16.4 Cache invalidation — VERIFIED CORRECT

`useInventory.ts` initially looked like a defect (`useMutation=2, finViews=0`). Verified: its two
mutations only create **fabrics** (`:195-213`) and **rolls** (`:222-241`), invalidating
`KEYS.fabrics()` and `KEYS.rolls()`. Catalogue data touches no ledger, cashbox or statement, so
omitting `invalidateFinancialViews` is correct rather than a gap. Every hook that *does* write money
uses it:

```
useCashbox.ts    useMutation=4  finViews=4  invalidateQueries=7
useExpenses.ts   useMutation=2  finViews=4  invalidateQueries=3
useInventory.ts  useMutation=2  finViews=0  invalidateQueries=2   <- catalogue only, correct
useParties.ts    useMutation=2  finViews=5  invalidateQueries=2
useStatement.ts  useMutation=2  finViews=3  invalidateQueries=2
```

### 16.5 Pagination and totals — INCONCLUSIVE, not verified

Raw token counts suggested pagination exists in the list views (`receipts.index` page=15,
`payments.index` page=15, `expenses.index` page=21, `inventory` page=35, `ledger` page=25) while
`customers.index` and `suppliers.index` show page=4. Token frequency is **not** evidence of working
pagination — the strings `page`/`total` also appear in unrelated identifiers. Whether these views
paginate, cap their page size, and render correct totals was **not** established and is listed as a gap
below, not as a pass.

### 16.6 Group B coverage after this pass

| Check | Verdict |
|---|---|
| Label/control association | **Complete** — 3 cases verified, none defective |
| Currency separation (USD vs SYP) | **Complete** — verified correct |
| Double-submit guards | **Complete** — none missing |
| Cache invalidation | **Complete** — verified correct incl. the one apparent exception |
| Ad-hoc money rounding | **Complete** — none present |
| Clickable non-interactive elements | **Complete** — none present |
| Payload vs backend Zod contract (voucher/cashbox/expense/party/roll) | **Not done** |
| Per-field validation vs backend rules | **Not done** |
| Loading / empty / error states per page | **Not done** |
| Pagination, totals, sorting consistency | **Not done** — 16.5 |
| Refresh-survival of entered data | **Not done** |
| RTL layout and keyboard interaction | **Not done** |
| Offline persistence and sync behaviour | **Not done** |

Mission Phase 2 remains substantially incomplete for these 19 routes (~4,900 lines). §16 covers the
eight systematic checks and nothing more.

---

## 17. AUDIT CLOSE-OUT AND STANDING

### 17.1 Final finding register

**10 defects:**

| ID | Sev | Finding | Verified by |
|---|---|---|---|
| F-001 | High | Two CI steps run zero tests (`ci.yml:55`, `ci.yml:98`) | lead auditor, real exit codes |
| F-002 | High | `npm run lint` exits 1 — 245 errors + 50 warnings; 812 files fail Prettier | lead auditor |
| F-004 | High | FORCE-RLS sweep exempts only `revoked_tokens` by name; 6 tables have nullable `tenant_id`, `sync_state` has no policy | lead auditor (static; runtime unverified) |
| F-013 | High | Dye purge hard-DELETEs `ledger_entries` on PostgreSQL, which the trigger forbids; SQLite twin has the escape hatch, PG has none | lead auditor (static; runtime unverified) |
| F-006 | Med | Money passed through `REAL` (float) in migration 0024, truncated by 0026's `::BIGINT` | lead auditor (static) |
| F-007 | Med | 12 backend subsystems with no subsystem-named test file | lead auditor |
| F-008 | Med | `round2dp` is IEEE-754 float, not scaled-integer | lead auditor |
| F-010 | Med | `POST /orders` accepts a financial mutation with no `Idempotency-Key` | lead auditor |
| F-012 | Med | Password reset enforces only 6 chars and bypasses the `isWeakPin` rule | lead auditor |
| F-011 | Low | `HeaderField` renders `<Label>` with no `htmlFor` across 14 invoice fields | lead auditor |

**3 positive findings:** F-003 (`npm audit` clean — the older audit's 14/10 are resolved), F-005
(schema/journal parity holds, 47 shared tables, 0 column differences), F-009 (0 of 37 repository twins
diverge on any behavioural signal).

### 17.2 What was verified sound (so a future audit does not re-open it)

- **Auth subsystem:** login rate limiting (5/15 min), refresh reuse detection, single-use rotation,
  session-cutoff enforcement, license gate before minting, logout revocation, and an error handler that
  leaks no stack/SQL/PII (§14.2).
- **Ledger append-only:** 21 of 22 application writes are trigger-compliant cancellations; only the dye
  purge violates it (§15.1).
- **Statement ordering:** both engines, both query paths, `date, created_at, docRank, id` (§12.2).
- **Currency separation:** independent SYP/USD boxes with an explicit no-FX-mix comment (§16.3).
- **Cache invalidation:** every money-writing hook calls `invalidateFinancialViews` (§16.4).
- **Typecheck:** both `tsc --noEmit` runs clean across ~114k lines.

### 17.3 Three defects the test setup structurally cannot catch

F-004 (RLS), F-006 (the `REAL` money migration) and F-013 (dye purge on PostgreSQL) all share one
cause: **the default test suite runs SQLite, and the defect exists only on PostgreSQL.** A
PostgreSQL-engine test run is the only thing that would surface them. This is the single highest-value
gap in the project's verification setup — higher than any individual finding above.

### 17.4 Deliverables and integrity

| File | Size |
|---|---|
| `CODEBASE_AUDIT_REPORT_hermes.md` | 17 sections |
| `CODEBASE_AUDIT_FINDINGS_hermes.json` | machine-readable, validated |
| `AUDIT_PROGRESS.md` | resume checkpoint |

- **HEAD unchanged throughout:** `2b9b602cb1f5e74c9db2fd39a1aae8c11fbb79f7`
- **No repository file modified.** Only untracked audit files were added.
- **Filename collision:** an unrelated whole-repository audit (84,344 lines, 31 findings) wrote
  `CODEBASE_AUDIT_REPORT.md` at 18:58, overwriting an earlier version of this document. This audit was
  relocated to the `_hermes` suffix and the other report was left untouched. The two audits are
  **independent** — where they overlap, compare evidence rather than assuming agreement.

### 17.5 What remains genuinely undone

**Not attempted or not completed:**

1. **Group E1** (cashbox, expenses, vouchers routes) — never dispatched successfully.
2. **Group F** (sync ×37 endpoints, backup, Drive, print, license, Tauri Rust) — read by a subagent;
   claims unverified.
3. **Frontend group C** (settings ×13, reports ×3, print-center, closing) — read by a subagent; claims
   unverified.
4. **Mission Phase 2** (field-by-field) — 8 systematic checks over 32 of 53 routes. Not per-field.
5. **Mission Phase 4** (business-workflow invariants) — not traced end-to-end for any workflow.
6. **Year-closing double-run, dashboard-vs-ledger totals, FX rate direction, statement balance
   list-vs-detail, `syncCoverage.ts` completeness.**
7. **Every test suite** — zero of ~230 test files executed (memory constraint).

**Provider constraint:** 6 of 9 dispatched groups were killed by `HTTP 429` fair-share rate limits,
each after completing its read phase but before synthesis. Groups D, E2, G and the two frontend groups
were recovered by direct lead-auditor work; E1, F and C were not.

---

## 18. GROUP E1 COMPLETED BY LEAD AUDITOR (cashbox, expenses, vouchers)

The E1 dispatch failed on `HTTP 429` at 311s after 30 API calls, having read its full scope:
`cashbox.route.ts`, `cashbox.schema.ts`, `cashboxUseCases.ts`, `cashboxBalanceHelper.ts`,
`dayLockHelper.ts`, `expense.route.ts/.schema.ts`, `expenseUseCases.ts`, `voucher.route.ts/.schema.ts`,
`voucherUseCases.ts`, the idempotency middleware, and both engines' cashbox and voucher repositories.
The lead auditor ran the money-critical checks directly.

### 18.1 FX conversion direction — VERIFIED CORRECT

The repo rule is `exchangeRate` = SYP per 1 USD, so USD→SYP multiplies and SYP→USD divides. Both
conversion paths in `packages/shared/src/fx.ts` implement exactly that:

```ts
// fx.ts:127-133 — convertForSettlement: the settlement path
  if (fromCurrency === BASE_CURRENCY) {           // USD -> SYP
    if (!isValidFxRate(enteredRate)) return null;
    return round2dp(amount * enteredRate);        // MULTIPLY  ✓
  }
  if (toCurrency === BASE_CURRENCY) {             // SYP -> USD
    if (!isValidFxRate(enteredRate)) return null;
    return round2dp(amount / enteredRate);        // DIVIDE    ✓
  }
```
```ts
// fx.ts:89-96 — convertAmount: the historical-combination path
  const fromRate = from.currency === BASE_CURRENCY ? 1 : from.exchangeRate;
  const toRate   = to.currency   === BASE_CURRENCY ? 1 : to.exchangeRate;
  if (!isValidFxRate(fromRate) || !isValidFxRate(toRate)) return null;
  return round2dp((amount / fromRate) * toRate);  // both sides routed via base, then round2dp ✓
```

Every conversion routes through `round2dp`, and an invalid rate returns `null` rather than silently
substituting 1. The comment at `:98-118` documents a subtle distinction — `convertAmount` uses each
side's own frozen historical rate while `convertForSettlement` uses the rate entered on the current
transaction — and explains that conflating them would "settle against a stale rate… for the single most
common cross-currency case (paying in USD against a SYP invoice)". No finding.

### 18.2 Cashbox day boundary — VERIFIED CORRECT (business date, not timestamp)

This was flagged as a risk because a UTC-derived day would misdate every cashbox operation for a
business running in UTC+3. Verified: the day is a **client-supplied business date string**, not a
server-derived timestamp.

```ts
// dayLockHelper.ts:24-33
  date: string,
  ...
    .where(and(eq(dayCloses.tenantId, tenantId), eq(dayCloses.date, date)))
  if (row) throw new DayLockedError(date);
```
```ts
// packages/shared/src/schemas/voucher.schema.ts:8
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
```

Neither `cashbox.route.ts` nor `voucher.route.ts` calls `new Date()` or `toISOString()` — the grep
returns zero matches. The date is validated as `YYYY-MM-DD` and compared as a string against
`day_closes.date`, so there is no local↔UTC conversion anywhere in the path. `assertYearOpen`
(`dayLockHelper.ts:52-53`) derives the year with `date.slice(0, 4)`, consistent with the same string
form. No finding.

### 18.3 Idempotency on these routes — VERIFIED (see F-010)

`cashbox.route.ts:130,181`, `expense.route.ts:43` and `voucher.route.ts:107,116` all pass
`idempotency("POST", { required: true })`. The only financial POST missing the flag is
`POST /orders` — recorded as **F-010** in §12.3.

### 18.4 Day-lock and year-lock enforcement

`dayLockHelper.ts:9` documents the contract: the lock check "Must run INSIDE the caller's transaction so
that [a concurrent close] cannot slip between the check and the write", and `:33` also asserts the
financial year is open on the same path. `DayLockedError` maps to 422 via the error handler's
`statusMap`. The enforcement points are present on the manual-movement and expense write paths.

### 18.5 Group E1 coverage after this pass

| Check | Verdict |
|---|---|
| FX conversion direction (both paths) | **Complete** — verified correct |
| Money rounding through `round2dp` | **Complete** — both conversion paths use it |
| Cashbox day boundary (local vs UTC) | **Complete** — verified correct (business-date string) |
| Idempotency enforcement | **Complete** — F-010 |
| Day-lock / year-lock enforcement points | **Partial** — presence verified; whether every write path calls them is not |
| Engine parity (cashbox, voucher repos) | **Complete** — covered by F-009 (0/37 diverge) |
| Cashbox balance endpoint vs closing endpoint agreement | **Not done** |
| Concurrency protection on same-party receipts | **Not done** |
| Cancel/reversal writing a compensating ledger entry | **Not done** |
| Transaction atomicity across voucher + ledger + invoice settlement + cashbox | **Not done** |

### 18.6 Financial subsystem — final coverage statement

With E1 and E2 both worked through, the financial area now stands at:

**Verified:** ledger append-only (22/22 call sites, F-013), statement ordering (both engines), FX
direction (both paths), money rounding, cashbox day boundary, idempotency on 9 of 10 financial POSTs
(F-010), engine parity across all 37 repository twins, currency separation in the cashbox UI, cache
invalidation on every money-writing hook.

**Still unverified:** cashbox balance vs day-close agreement, concurrency on same-party receipts,
compensating ledger entries on reversal, transaction atomicity across the voucher write set,
year-closing double-run, dashboard/report totals vs ledger, and the statement balance list-vs-detail
consistency. These are the remaining money-integrity questions and the first priority for a follow-up
session.

---

## 19. GROUP F PARTIAL AUDIT BY LEAD AUDITOR (sync ×37, backup/restore, Drive, print, Tauri Rust)

The group F dispatch failed on `HTTP 429` at 837s, having read its full scope: `sync.route.ts`
(including lines 1220-1539), `backup.route.ts`, `sqliteRestore.ts`, `drive.route.ts`, `coordinator.ts`,
`driveClient.ts`, `monthlyArchiveJob.ts`, `localAccess.ts`, `print.route.ts`, `settings.route.ts`,
`desktopRuntime.route.ts`, the relevant `server.ts` sections, and the Rust sources `main.rs`,
`identity.rs`, `secret_store.rs`, `google_ipc.rs`, `google_oauth.rs`, `device_binding.rs`, `pipe.rs`
and `stack.rs`. The lead auditor ran the highest-risk checks directly.

### 19.1 Sync endpoint authorization — VERIFIED SOUND (all 37)

Every one of the 37 `/sync/*` endpoints carries `auth` plus a scoped guard. Enumerated:

| Guard | Endpoints |
|---|---|
| `guards.readGuard` | `/hub-config` (GET), `/activity` (GET+POST), `/status`, `/inbox`, `/pending`, `/claims`, `/conflicts`, `/pull`, `/number-blocks`, `/devices/self/credential` |
| `guards.operatorGuard` | `/hub` (GET), `/hub-config` (PUT), `/hub-pair`, `/hub/test`, `/hub/connect`, `/hub` (DELETE), `/claims/reap`, `/number-blocks/reclaim`, `/devices` (GET), `/devices/:id/revoke`, `/devices/:id/reinstate`, `/enrollment-code` (GET/POST/DELETE), plus the 4 hub proxies |
| `guards.transportGuard` | `/run`, `/push` |
| `guards.conflictGuard` | `/conflicts/resolve` |
| `guards.numberingGuard` | `/number-blocks/claim` |

Representative evidence — `sync.route.ts`:

```ts
  router.get("/sync/hub-config", auth, guards.readGuard, async (_req, res) => {...});   // :192
  router.post("/sync/hub-pair", auth, guards.operatorGuard, async (req, res) => {...}); // :211-215
  router.post("/sync/push", auth, guards.transportGuard, async (req, res) => {...});    // :1039-1043
```

Reads and operator actions are separated by guard, not lumped behind a single `auth`. No finding.

### 19.2 Tauri ACL wiring — VERIFIED SOUND

The repo requires every Tauri command to appear in `build.rs` `APP_COMMANDS` **and** the capability
ACL, guarded by `desktop/scripts/ipc-acl-wiring.test.mjs`. Verified independently across all three
layers:

```
generate_handler! entries (main.rs:368-440):  26
build.rs APP_COMMANDS:                        26
capability ACL grants (both files combined):  26
registered but granted nowhere:               (none)
granted but not registered:                   (none)
```

**A false positive worth recording.** Comparing `main.rs`'s handler list against
`capabilities/main-window.json` alone flagged **6 commands as "ACL-dead"**
(`recovery_status`, `recovery_retry`, `recovery_log_tail`, `recovery_exit`, `startup_status`,
`startup_choose`). That is wrong: Tauri ACL keys are hyphenated (`allow-get-fingerprint`) while Rust
command names are underscored (`get_fingerprint`), and those six commands are granted by a **second**
capability file, `capabilities/recovery-window.json:9-14`, scoped to its own `recovery` window
(`:3-6`: "the in-app recovery dialog… needs nothing but its own commands"). Only after normalising
underscores→hyphens and unioning both capability files does the set match exactly, 26↔26.

*Lesson: the ACL check must compare all capability files, not just `main-window.json`, and must
normalise the underscore/hyphen difference.* No finding.

### 19.3 CONFIRMED DEFECT — backup path endpoints accept an arbitrary host filesystem path

**F-014 — `/backup/verify-path` and `/backup/restore-path` accept any absolute path with no directory restriction**
- **location:** `backend/src/presentation/routes/backup.route.ts`
- **file:** `backend/src/presentation/routes/backup.route.ts:174-194` (the shared validator), used at `:463-465`, `:532-534` and the restore path
- **type:** security issue
- **severity:** **Medium** (see the mitigation note — this is materially narrower than the older audit's claim)
- **evidence:**

```ts
// backup.route.ts:174-194
async function receiveShellPath(req: Request): Promise<{ path: string; ... }> {
  const body = (req.body ?? {}) as { path?: unknown; sha256?: unknown; sizeBytes?: unknown };
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path) throw new BackupError("BACKUP_CORRUPT", "...");
  ...
  if (!existsSync(path)) throw new BackupError("BACKUP_FILE_MISSING", ...);
  const st = statSync(path);
  if (!st.isFile()) throw new BackupError("BACKUP_FILE_MISSING", ...);
  ...
  return { path, reportedSha256, reportedSize };
}
```

The validation covers **existence, file-type, non-emptiness, and an optional size/sha256 match** — but
never restricts *which* path may be named. `openAndVerifyBackupV3(path, …)` and the restore path then
open that arbitrary file.

- **actual:** an authenticated admin can name any path on the host — `C:/Users/<other>/.ssh/id_rsa`,
  a secrets file, another tenant's database — and have the server open, hash, parse and report on it.
  The `sha256`/`sizeBytes` checks verify integrity *against the caller's own claim*, not provenance, so
  they do not constrain the path.
- **expected:** the path should be confined to the application's own backup root (or an allow-list of
  sanctioned directories), consistent with how `MOTARD_BACKUP_REGISTRY` scopes the registry.
- **mitigation that lowers this from Critical to Medium:** the router is **not** unauthenticated. It is
  registered behind `authMiddleware` and `rbac(["admin"])` (`server.ts:533-536`), so this requires a
  valid admin session and is not reachable from the LAN by an anonymous caller.
- **affected:** `backup.route.ts:463-465` (`/backup/verify-path`), `:532-534` (the second
  `verify-path`), and the `restore-path` handler that shares `receiveShellPath`.
- **downstream_effects:** arbitrary file read (metadata, hash, and parse errors that can leak path
  content) and, via restore, the ability to load an attacker-chosen SQLite file into the live
  application. Requires admin credentials.
- **reproduction:** as an admin, `POST /api/backup/verify-path` with
  `{"path":"C:/Windows/System32/config/SAM"}` — the server opens and hashes the file instead of
  rejecting the path.
- **existing_test_coverage:** the dfp028 backup script gate tests the backup *pipeline*, not path
  provenance; no test asserts an out-of-root path is refused.
- **recommended_fix:** resolve the path and assert it is inside the configured backup root before
  `existsSync`; reject with a distinct error otherwise. Note the desktop shell legitimately hands over
  a user-picked file (`pick_backup_file`), so the allow-list must include the OS file-picker's
  sanctioned location, not only the backup root.
- **regression_risk:** medium — over-restricting will break the legitimate "restore from a
  user-picked file" desktop flow, which is the whole point of the path-based endpoints. The allow-list
  must be designed with that flow in mind.
- **regression_test:** a test that a path outside every sanctioned directory is rejected with a
  distinct error, and that a path inside the backup root still succeeds.
- **confidence:** **Confirmed** — the validator and both call sites were read directly, and the
  router's `authMiddleware` + `rbac(["admin"])` registration was verified at `server.ts:533-536`.
- **correction to a prior audit:** `MOTARD_ERP_FULL_FORENSIC_AUDIT.md` §0 lists "one unauthenticated
  LAN-reachable arbitrary-path restore (P1)". That characterisation **does not hold at this HEAD** —
  the route is behind auth and admin RBAC. The path-restriction defect is real; the *unauthenticated*
  part is not.

### 19.4 Group F coverage after this pass

| Check | Verdict |
|---|---|
| Sync endpoint authorization (all 37) | **Complete** — verified sound |
| Tauri command ↔ `build.rs` ↔ capability ACL | **Complete** — 26↔26↔26, verified sound |
| Backup path provenance | **Complete** — F-014 |
| Drive token bridge existence | **Complete** — verified present (§7.1 disproof) |
| Sync outbox replay idempotency | **Not done** |
| Conflict resolution data-loss behaviour | **Not done** |
| Backup/restore partial-state handling | **Not done** — the v3 pipeline was read by the agent but not analysed |
| Rust `unwrap()`/`expect()` panic surface | **Not done** |
| Secrets via DPAPI vs env/localStorage | **Not done** — `secret_store.rs` was read by the agent, not analysed |
| webview localStorage retaining tokens across factory reset | **Not done** |
| `syncCoverage.ts` completeness | **Not done** |

### 19.5 Remaining work after every group

With F partially worked, the audit's outstanding items are:

1. **Sync replay idempotency and conflict-resolution data-loss behaviour** — the highest-risk unexamined
   area, since a non-idempotent replay corrupts data across every device.
2. **Rust panic surface** (`unwrap`/`expect` on user input) and DPAPI secret handling.
3. **Backup/restore partial-state handling.**
4. **Frontend group C** (settings ×13, reports ×3, print-center, closing) — read by a subagent, unverified.
5. **Mission Phase 2** field-by-field and **Phase 4** workflow invariants.
6. **Money-integrity checks** listed in §18.6.
7. **Every test suite** — zero of ~230 files executed (memory constraint).

---

## 20. FRONTEND GROUP C COMPLETED (settings ×13, reports ×3, print-center, closing)

This was the **only** dispatched subagent that completed (1,305s, 55 API calls). It returned 20 findings
with `file:line` citations. Because subagent self-reports are not evidence — and three of this agent's
siblings had produced wrong claims (§7.1) — the lead auditor independently verified the Critical and High
findings at source before admitting them to the register. **All four were reproduced exactly as
reported.**

### 20.1 CRITICAL — the user manager writes to memory only; created users can never authenticate

**F-015 — `/settings/users` CRUD mutates an in-memory array with no server call and no persistence, so created users vanish on reload and cannot log in**
- **location:** `/settings/users`
- **file:** `src/presentation/hooks/useSettings.ts:417-442` (CRUD), `src/routes/settings.users.tsx:89-109` (caller)
- **type:** functional defect
- **severity:** **Critical**
- **evidence** — every other settings section persists; `users` never does:

```
persistSection call sites in useSettings.ts:
  :282 company   :307 units   :318 units   :326 units   :337 warehouses
  :348 warehouses :356 warehouses :366 taxes :376 taxes :384 taxes
  :394 paymentMethods :404 paymentMethods :412 paymentMethods
  :450 company   :457 printing  :468 currencies
                                          <-- NO persistSection("users") anywhere
```

```ts
// useSettings.ts:417-426
export function addUser(v: Omit<SystemUser, "id" | "createdAt">): SystemUser {
  const u: SystemUser = { ...v, id: nextId("usr"), createdAt: localToday() };
  settings.users.push(u);
  logActivity("المستخدمون", "إضافة مستخدم", `${u.name} — ${ROLE_LABEL[u.role]}`);
  notify();
  return u;                    // <-- no persistSection(), unlike every other CRUD in this file
}
```
```ts
// useSettings.ts:429-442 — updateUser and deleteUser are the same shape: mutate + notify(), no persist
export function updateUser(id: string, patch: Partial<SystemUser>) { ... Object.assign(u, patch); logActivity(...); notify(); }
export function deleteUser(id: string) { ... settings.users = settings.users.filter(...); logActivity(...); notify(); }
```

The backend cannot accept it even if the page tried — the settings allowlist has no `users` section:

```ts
// backend/src/presentation/routes/settings.route.ts:39-52
    if (!["company","currencies","paymentMethods","taxes","units","warehouses","printing","drive"].includes(section)) {
      return res.status(400).json({ code: "VALIDATION", message: "قسم غير صالح" });
    }
```

The real user endpoints exist and are never called by this page:
`backend/src/presentation/routes/user.route.ts` — `POST /users` (`:50`), `PATCH /users/:id` (`:87`),
`DELETE /users/:id` (`:137`), `POST /users/:id/reset-password` (`:184`).

- **actual:** an admin adds a user, sees the success toast, and the row disappears on reload. The new
  account **cannot authenticate at all** — it was never written to the `users` table the auth middleware
  reads. Compounding this, the in-memory `SystemUser` type carries a **plaintext** `password?: string`
  (`useSettings.ts:50-60`) with no `passwordHash` field, so even a hypothetical local login path could
  not match the Argon2 hashes `PasswordHasher` produces.
- **expected:** the page should call the real user endpoints (list on load, PATCH on edit, POST +
  reset-password on create, DELETE on remove) so created users exist server-side and can log in; at
  minimum the page must not present itself as a working user manager.
- **affected:** `src/presentation/hooks/useSettings.ts:417-442`; `src/routes/settings.users.tsx:89-109`;
  `backend/src/presentation/routes/user.route.ts` (written but unused by the UI);
  `src/components/auth/UserPickerPage.tsx` (login cannot see these users — verified: no reference to
  `useUsers`, `listUsers`, or `api.users`).
- **downstream_effects:** an admin believes they have provisioned staff accounts; those staff cannot log
  in. In a multi-device deployment the phantom users exist on one browser only. Combined with C1-02, the
  activity log records the creation as if it succeeded.
- **reproduction:** `/settings/users` → add a user → reload the page. The row is gone. Attempt to log in
  as that user → rejected.
- **existing_test_coverage:** none.
- **recommended_fix:** wire the page to `POST/PATCH/DELETE /users` and `POST /users/:id/reset-password`;
  remove the plaintext `password` from `SystemUser`. Do **not** add `users` to the settings allowlist —
  user records are tenant business data with their own routes, not a settings section.
- **regression_risk:** medium — the settings screen currently drives off a synchronous in-memory list;
  moving to server calls introduces loading and error states the screen does not render yet.
- **regression_test:** add a user, reload, assert it is present; log in as that user and assert success.
- **confidence:** **Confirmed** — CRUD functions, the full `persistSection` call-site list, the backend
  allowlist, the unused user routes, the `SystemUser` type and the login component were all read
  directly by the lead auditor.

### 20.2 HIGH — activity log is device-local memory; the promised audit trail does not survive reload

**F-016 — `/settings/activity` reads a module-scope array that is never persisted, so the audit trail is empty after refresh**
- **location:** `/settings/activity`
- **file:** `src/presentation/hooks/useSettings.ts:198, 207-217, 473-476`
- **type:** data integrity
- **severity:** **High**
- **evidence:**

```ts
// useSettings.ts:198
  activity: [] as ActivityEntry[],
// useSettings.ts:207-217
export function logActivity(module: string, action: string, detail?: string) {
  settings.activity.unshift({ ... });
  if (settings.activity.length > 500) settings.activity.length = 500;
}   // <-- no persistence
// useSettings.ts:473-476
export function clearActivity() { settings.activity = []; notify(); }   // wipes the whole trail
```

`loadSettings()` (`:250-297`) merges only `company`, `units`, `taxes`, `warehouses`, `paymentMethods`,
`currencies` and `printing` — never `activity`. There is no `activity` settings section and no backend
route for one. Meanwhile the backend **does** expose `GET /sync/activity`
(`backend/src/presentation/routes/sync.route.ts:452`), which this page does not use.

- **actual:** all 23 `logActivity` call sites write to a JavaScript array discarded on reload. The page
  advertises "آخر الإجراءات التي تمت داخل النظام" but is empty after a refresh, and "مسح" destroys what
  remains behind a bare `window.confirm`.
- **expected:** the trail must be durable (server-side, per tenant) or the screen must state it is a
  local, non-authoritative log.
- **affected:** 23 `logActivity` call sites across `src/`; `backend/src/presentation/routes/sync.route.ts:452` (an unused durable alternative).
- **confidence:** **Confirmed** — the array declaration, `logActivity`, `clearActivity` and the
  `loadSettings` merge list were all read directly.

### 20.3 HIGH — invoice print-visibility saves to localStorage only

**F-017 — invoice print-field visibility is written to localStorage and never replicates to other devices**
- **location:** `/settings/invoice`
- **file:** `src/components/print/invoices/visibility.ts:57, 166-169`
- **type:** integration defect
- **severity:** **High**
- **evidence:**

```ts
// visibility.ts:57, 166-169
const STORAGE_KEY = "motard.invoice.printVisibility.v2";
function saveVisibility(v) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* ignore quota */ }
}
```

The same screen's printing block *does* persist (`updatePrinting(p)` → `PUT /settings/printing`,
`settings.invoice.tsx:117-124`), and `printing` is an allowlisted section
(`settings.route.ts:47`). So the page mixes a replicated section with a local-only one under one heading.

- **actual:** toggling a field's visibility writes one browser's localStorage. A second workstation — or
  a reinstalled desktop — prints every field, because the setting never leaves the device.
- **expected:** visibility belongs in the `printing` section so it replicates like `paperSize` and
  `footerNote` already do.
- **affected:** `src/components/print/invoices/visibility.ts`; the Sale/Entry/Return print components all
  read from this local store.
- **confidence:** **Confirmed** — `STORAGE_KEY`, `saveVisibility`, and the contrasting persisting
  printing block were all read directly.

### 20.4 HIGH — settings pages snapshot pre-load defaults, so a fast save overwrites persisted values

**F-018 — settings forms seed `useState` from built-in defaults before the server GET resolves, so an early save PUTs defaults over saved data**
- **location:** `/settings/company`, `/settings/printing`, `/settings/invoice`
- **file:** `src/routes/settings.company.tsx:12-13`, `src/routes/settings.printing.tsx:13-14`, `src/routes/settings.invoice.tsx:177-180`
- **type:** functional defect
- **severity:** **High**
- **evidence:**

```tsx
// settings.company.tsx:12-13
  useSettings();
  const [c, setC] = useState({ ...settings.company });   // built-in defaults; server data not merged yet
// settings.printing.tsx:13-14
  const [p, setP] = useState({ ...settings.printing });
```

`useSettings()` fires `loadSettings()` in an effect, which awaits
`container.settings.api.getSettings()` and then **replaces** `settings.company`/`settings.printing`. The
local `useState` is never re-synced — no effect is keyed on the loaded object.

- **actual:** if the operator types and presses حفظ before the GET returns (a few hundred ms on a cold
  desktop start), `updateCompany(c)`/`updatePrinting(p)` PUTs the hard-coded defaults over the company's
  saved name, address, tax number and paper size. The page shows the typed text and a success toast
  while the stored record reverts.
- **expected:** form state initialises from the loaded server value, or is re-seeded when the loaded
  object changes, before save is enabled.
- **affected:** `src/presentation/hooks/useSettings.ts:250-297`; `settings.invoice.tsx:117-124`.
- **confidence:** **Confirmed** — both snapshot sites and the `useSettings()`/`loadSettings()` sequence
  were read directly.

### 20.5 MEDIUM — year close/reopen invalidates three ad-hoc keys instead of the central helper

**F-019 — `closing.tsx` `refreshAll()` omits `invalidateFinancialViews`, leaving cashbox/ledger/statement stale after a close**
- **location:** `/closing`
- **file:** `src/routes/closing.tsx:74-78`
- **type:** functional defect
- **severity:** **Medium**
- **evidence:**

```tsx
// closing.tsx:74-78
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["closing-preview"] });
    void qc.invalidateQueries({ queryKey: ["count-sheet"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
  };
```
Called from both `close.mutate` `onSuccess` (`:88`) and `reopen.mutate` `onSuccess` (`:99`).

The central helper covers exactly what is missing — `invalidateFinancialViews.ts:15-26` invalidates
`dashboard`, `cashbox`, `ledger`, `profit`, `statement`, `party`, `parties` and `invoices`, plus
`refreshParties()`. The project rule (CONTRACT line 21) is "Frontend money mutations must call
`invalidateFinancialViews(qc)`."

- **actual:** after closing — the operation that freezes the books and the closing cashbox balances —
  the cashbox, ledger, statement, profit, dashboard and party-balance caches keep serving pre-close
  numbers until something else invalidates them.
- **expected:** `refreshAll()` calls `invalidateFinancialViews(qc)` alongside the count-sheet/inventory keys.
- **affected:** every screen reading `["cashbox"]`, `["ledger"]`, `["statement"]`, `["parties"]` after a close.
- **confidence:** **Confirmed** — read directly at `closing.tsx:74-78, 88, 99`.

### 20.6 Remaining group C findings — recorded, not independently re-verified

The subagent's other 15 findings are preserved in its full output
(`C:\Users\Taw\AppData\Local\hermes\cache\delegation\subagent-summary-2-20261011_184507_321352.txt`) and
summarised below. They are **leads**: cited with line numbers by an auditor that did read the files, but
not re-verified by the lead auditor, so they are **not** in the confirmed register.

| ID | Sev | Claim |
|---|---|---|
| C1-05 | Med | `/reports` "الأطراف" tile links to slug `receivables`, absent from the backend switch (`reports.route.ts:83-125`) — the SPA renders it locally, so the tile works, but three implemented slugs (`sales-returns`, `top-fabrics`, `top-customers`) have no entry point |
| C1-06 | Med | Party-balance rows sorted by SYP remaining only (`reports.$slug.tsx:695`), so a party owing entirely in USD sorts as zero — the worst debtor can appear last |
| C1-08 | Low | `DriveQueueJob.entityId` typed required; `/drive/status` omits it while `/drive/queue` includes it — the two endpoints disagree on row shape |
| C1-09 | Med | Settings dialogs use raw `<Label>` with no `htmlFor`/`useId` across 6 route files — the same class as F-011, different component |
| C1-10 | Med | Destructive deletes use blocking `window.confirm` instead of the app's `ConfirmDialog` |
| C1-11 | Med | Plaintext password input in the user form, and password included in exported JSON |
| C1-12 | Med | `ROLE_ALLOWED_PATHS` disagrees with the nav's admin gate |
| C1-13 | Low | Role-label typo |
| C1-14 | Low | Inline rounding instead of `round2dp` |
| C1-15 | Low | Print-center never surfaces the print-job lifecycle |
| C1-16 | Med | Backup import writes memory only, no PUT |
| C1-17 | Med | Password field exported |
| C1-18 | Low | Dead `nameEn` field |
| C1-19 | Low | Admin-gate flicker while the current-user query resolves |
| C1-20 | Low | The same four printing controls and the same PUT exist in two settings screens with independent local state — last write wins |

C1-11/C1-16/C1-17 overlap on the plaintext-password root cause; the agent kept them separate because the
input masking and the export payload are distinct defects with distinct fixes. That is a reasonable call.

### 20.7 Group C coverage

| Check | Verdict |
|---|---|
| Settings save path vs backend allowlist | **Complete** — F-015, and the allowlist verified |
| User CRUD persistence | **Complete** — F-015 (Critical) |
| Activity log durability | **Complete** — F-016 |
| Print visibility replication | **Complete** — F-017 |
| Form seeding vs async load | **Complete** — F-018 |
| Cache invalidation on close/reopen | **Complete** — F-019 |
| Drive endpoint existence | **Complete** — agent verified all paths exist; no defect |
| Backup verify/restore flow match | **Complete** — agent verified; no defect |
| RBAC roles vs backend enum | **Complete** — agent verified exact match |
| Report slug coverage | **Partial** — C1-05/C1-06 are leads |
| The remaining 15 findings | **Leads only** — not re-verified |
