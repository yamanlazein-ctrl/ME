# US6 — Volume and history completeness (T111, T112; T113 open)

Date: 2026-10-04. Branch `clean-desktop-release`. Harness: `node scripts/parity/volume.mjs`, output in
`scripts/parity/out/volume.json`.

The harness:

- seeds **exactly** the T025 dataset: same tenant id, md5-derived UUIDs, numbers, dates and amounts. This gives
  100,000 invoices, 200,000 ledger rows and 10,000 parties, with one "deep" customer holding 20% of the invoices;
- creates the SQLite database through the production FRESH boot;
- measures on the real backend endpoints;
- walks every list to the end through its keyset cursor.

## Gate run (after T112): **18/18 PASS**

| Check | Result | PG baseline / target |
|---|---|---|
| customers / suppliers / invoices / ledger rows / cash-box days | 8000 / 2000 / 100000 / 200000 / 1462 | identical |
| statements: parties / lines / deepest | 8000 / 200000 / 40,020 lines | identical |
| sha256 over every statement's ordered ledger ids | `439d33d2…be3c` | **identical** |
| cash-box closing balance | 149695750.00 | identical |
| customers first page / full walk | 43 ms / 8000 rows in 9 pages | < 2 s / all |
| suppliers first page / full walk | 22 ms / 2000 rows in 3 pages | < 2 s / all |
| invoices first page / full walk | 36 ms / 100000 rows in 101 pages | < 2 s / all |
| statement first page (deepest party) | 72 ms | < 2 s |
| full single-party statement (40,020 lines, 81 pages of 500, as `fetchFullStatement` does) | **8.2 s** | < 10 s |

No limit was added anywhere.

## T112 — what missed and what was added

The first runs missed the full-statement target: **12.5–22.6 s**, with roughly 150–300 ms per page regardless of
page number. Profiling the repository (per-statement timings through better-sqlite3) showed two problems:

- **Planner trap on document lookups.** The query `invoices WHERE id IN (…250 ids…) AND tenant_id = ?` was answered
  through `idx_invoices_type (tenant_id)`, which scans all 100k invoices of the tenant: 61 ms per call. SQLite has no
  statistics on a fresh file, and the composite equality looks cheaper to the planner than 250 primary-key seeks.
- **Full scan in the line-detail join.** `invoice_lines.invoice_id IN (…)` is filtered on the joined `invoices`
  tenant, and no index starts with `invoice_id`, so the plan was `SCAN invoice_lines` on every page. The T025 dataset
  has no invoice lines, so the gate figure understates this cost on real data; it was found from the query plan.

Forward migration `0001_statement_lookup_indexes.sql` adds indexes only:

- `invoices (tenant_id, id)`: the lookup becomes a seek on both predicates, **61 ms → 1.5 ms**;
- `vouchers (tenant_id, id)`: the same lookup shape in `loadDocuments`;
- `invoice_lines (invoice_id)`.

Two other options were measured and **not** used:

- `ANALYZE`: 4.3 ms, but it is not an index, and a fresh database has no statistics to begin with;
- a covering ledger index for the per-page totals: only about 6 ms per page.

The search code is unchanged, so T063 search parity needs no re-run. The committed SQLite fingerprint was regenerated
(129 indexes), and the journal-dependent tests (`tests/sqlite/connection.test.ts`) now derive the shipped journal's
last index instead of assuming 0. Full SQLite suite with the migration: 730 passed, 37 skipped, 2 failed. Both
failures were in the one test file fixed below, which now passes 4/4; the full suite was not re-run after that fix.

## Also fixed during this run

`tests/sync-conflict-record-fail-closed.test.ts` failed on SQLite (2 tests: `SQLITE_NOT_INITIALIZED`). Its module mock
of `orm/sqlite/transaction.js` never reached the store, because `engineStores` loads it with a dynamic import. On
SQLite the test now stubs the cached store's `insertOpen` (after booting the runtime), so both engines prove the same
fail-closed contract. Result: 4/4 on each engine.

## T113 — 1,000,000-invoice soak (report only, 2026-10-05)

`node scripts/parity/volume.mjs --invoices 1000000 --parties 100000` seeds the same generator at 10× the gate:
1,000,000 invoices, 2,000,000 ledger rows and 100,000 parties. The deep customer holds 200,000 invoices. Seeding took
1074 s. Completeness is reported, not compared, because the PG baseline is the 100k gate. Output:
`scripts/parity/out/volume-soak-1m.json`.

| Measure | Result |
|---|---|
| every customer / supplier / invoice reachable through its keyset cursor | **100%**: 80,000 / 20,000 / 1,000,000 (81 / 21 / 1001 pages) |
| full statement of the deepest party: every line present | **100%**: 400,020 / 400,020 lines (801 pages) |
| customers / suppliers first page | 133 ms / 77 ms |
| invoices first page | **2,239 ms** (the gate target is 2 s at 100k; this is 10×) |
| statement first page | 1,569 ms |
| full single-party statement, 400,020 lines | **623 s** (~0.78 s per 500-line page) |

Reading: history stays complete at 10× the gate; nothing is truncated or lost. The giant statement is slow because each
page re-computes the full-window totals and the party balance over all of the party's rows. The cost per page therefore
grows with the party's size: about 0.1 s per page at 40k lines, about 0.78 s at 400k. Computing the window totals once,
on the first page only, would make each later page cheap. That is a code change outside T112's "indexes only" rule, and
the gate targets are met, so it is recorded here as a follow-up rather than done.
