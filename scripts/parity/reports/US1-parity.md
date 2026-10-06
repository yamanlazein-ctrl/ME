# US1 — business parity: PostgreSQL reference ↔ SQLite desktop (2026-10-04)

**Result: PASS.** Empty diff (SC-001 / AC-3) between the frozen PostgreSQL reference build and the
SQLite build, across 67 canonical files (14 API transcripts + 53 business tables).

## Oracle and system under test

| | Build | How it ran |
|---|---|---|
| Reference (oracle) | T026 build, `server.mjs` sha256 `12057be8…bf930`, bundled 2026-10-03 18:46 and packaged into `reference-pg-1.2.0-setup.exe` (sha256 `4e9fb793…549f`, 18:50) | `node scripts/parity/run.mjs --engine postgres --reference <copy of target/release/server/server.mjs> --out scripts/parity/baseline/ref` on a fresh PostgreSQL 17 database (locale C), desktop mode |
| SUT | current working tree, `DB_ENGINE=sqlite` | `node scripts/parity/run.mjs --engine sqlite --out scripts/parity/out/sut` on a FRESH SQLite file + the build-time desktop seed |

Both start from the same clean state: the desktop seed (default tenant + pre-signed licence),
then the real onboarding API (init → activate → company → admin → review → complete → login).

## Scenario set (T050 — HTTP API only)

| File | Covers (T050 name) |
|---|---|
| 01-master-data | parties.mjs, inventory.mjs (fabrics → colours → rolls) |
| 02-invoices | invoices.mjs (sale/entry, SYP/USD, discounts, tax, shipping, partial pay, over-sell rejection, next number) |
| 03-vouchers | vouchers.mjs (linked receipt with discount, USD receipt, payment, cancel + double-cancel rejection) |
| 04-returns | returns.mjs (sale + entry returns, over-return rejection) |
| 05-statements | settlements.mjs (statements, multi-invoice settlement with discount, credit, ledger balance/party/at-date) |
| 06-cashbox-expenses | cashbox.mjs (opening, manual in/out, expenses incl. cancel, day close, locked day) |
| 07-cancel-and-delete | cancellations.mjs (invoice/voucher/return cancel, stale version, D-4 list absence + by-id history presence) |
| 08-reports-search | dashboard, every report slug, party balances, profit, Arabic/Latin/`%`/`_` search, keyset paging, document graph |
| 09-inventory-counts | inventory.mjs part 2 (begin counting, full count sheet, variance, post adjustment) |
| 10-currency-rounding | invoices.mjs EUR + fractional quantities; rounding.mjs (x.xx5 products, line discounts, tax/shipping) |
| 11-purge-merge | purge-merge.mjs (party purge cascade, dye purge cascade incl. wrong confirmation, party merge*) |
| 13-financial-years | financial-years.mjs (count completion, preview, close with typed confirmation, write refused in closed year, reopen) |
| 14-concurrency | concurrency.mjs (5 parallel sales on one roll → 3 succeed, stock never negative; 6 parallel sales → unique, gapless numbers) |

\* Party merge is refused over HTTP whenever sync enqueue is on (`isSyncEnqueueEnabled()` is
always true): `MERGE_UNAVAILABLE_WITH_SYNC` on both builds. The merge logic itself is covered by
`backend/tests/party-merge.test.ts`, green on both engines.

## Canonical form (T051, `scripts/parity/lib/canonical.mjs`)

- UUIDs → labels in creation order (API transcript first, then table content order); references
  derived from a UUID prefix (`CNT-2026-<8 hex>`) → the same label.
- Money exact: PG numeric text vs SQLite scaled integer rendered at the column scale.
- Timestamps: presence only. Wall time differs per run; order effects are still compared through
  list order. A global rank is not engine-stable (API ms Dates vs table µs text).
- Engine-independent nondeterminism, normalised and documented (each also varies run-to-run on
  PostgreSQL alone):
  - **same-date ties**: rows of one transaction share `created_at`, so the `id` tiebreak is random.
    They are compared in content order, with `seq` and intermediate `runningBalance` masked; the last
    running balance of the day and all totals are compared.
  - **statement line detail** is read with no ORDER BY on either engine (PG plan order), so it is
    compared as a set.
  - **count sheet** is ordered by roll id (random per run), so it is compared by roll number.
  - **parallel requests**: which of several identical requests got which number, and the commit-order
    fields (serial ids, outbox seq, stock seen) are timing. Compared as an equivalence class; the
    outcome (statuses, the exact set of numbers, uniqueness, gaplessness) is compared exactly. Scope:
    103 of 539 rows, all belonging to the 9 parallel invoices and 2 rejected requests.
  - random-by-design values (password/PIN hashes, AES-GCM iv/ciphertext/tag): presence only.

## Defects found by the parity and isolation runs, and fixed

1. SQLite activation failed: 7 SQLite stores existed but were never wired (`engineStores.ts`).
2. Year closing, dye purge, party purge and colour deletion ran the **PostgreSQL** helper SQL on
   SQLite (`engineHelpers.ts` now selects the twin).
3. First-run restore, `/sync/hub`, `/sync/run` and `/integrity/accept-baseline` loaded the PG layer
   on SQLite (SQLite branches added; the sync run lock is an in-process lock on the desktop).
4. `/colors/search` and `/rolls/search` without a filter id: PG fails (`''::uuid`, 22P02) and the
   unhandled rejection ends the process. The SQLite twin now reproduces the same failure (owner item
   **O-2**, next to O-1 by-ids).
5. Document-track search on SQLite: `ESCAPE '\'` became `ESCAPE ''` inside a template literal.
6. INSERT/UPDATE … RETURNING outside a transaction was routed to the read-only connection
   (`stmt.reader` without `stmt.readonly`).
7. A statement the reader cannot prepare (DDL against a stale schema view) now goes to the writer.

## Tenant isolation (T049, `scripts/parity/isolation.mjs`)

PASS on both engines, twice each. All of company A's business data is cloned into tenant B (every
id remapped). Results:

- 82 GET endpoints/queries are byte-identical for A whether B exists or not (keys sorted).
- No B id appears in any A response.
- 147 by-id reads of B's records return nothing of B.
- 78 cross-tenant writes (update, cancel, delete, purge) leave B byte-identical.
- New writes by A leave B byte-identical.

Two DELETEs of B's manual movements answer 204 on both engines but change nothing, because the
delete is idempotent. B's checksum proves no write reached B.
