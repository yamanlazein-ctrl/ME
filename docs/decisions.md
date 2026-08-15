# Decision Log

Sensitive, hard-to-reverse design decisions made during the forensic audit
fix protocol (2026-08-15 session), recorded so a future maintainer
understands *why*, not just *what*. Each entry follows the same evidence
discipline as the audit itself: no claim without a live before/after check
against a real Postgres instance.

---

## D-001 — 0013_db_hardening.sql applied via a guarded idempotent script, not `drizzle-kit migrate`

**Context.** The forensic audit (2026-08-15) found that migrations 0003
through 0019 are absent from `backend/src/infrastructure/orm/migrations/meta/_journal.json`
— the journal registers only `0001_initial`, `0002_platform_foundation`,
and `0005_license_extensions_and_system_admins`. `drizzle-kit migrate`
only ever executes migrations it knows about via that journal, so 0013
(and every other un-journaled migration) has never been applied by that
command, regardless of how many times it's run.

**A second, independent blocker was found live during this session**:
`0001_initial.sql` itself cannot be applied by `drizzle-kit migrate` at
all. It contains 23 uses of `CREATE POLICY IF NOT EXISTS`, which is not
valid PostgreSQL syntax in any version — `CREATE POLICY` has no
`IF NOT EXISTS` clause. The file also has zero `--> statement-breakpoint`
markers, so drizzle-kit sends its entire contents as one statement. Live
test: running `npx drizzle-kit migrate` against a freshly initialized,
empty database returned exit code 1 with zero output, and created **zero
tables**. Extracting and running the file's SQL directly confirmed the
exact failure: `syntax error at or near "NOT"` at the very first
`CREATE POLICY IF NOT EXISTS` statement.

**Conclusion:** `drizzle-kit migrate` has never successfully provisioned
this schema, on any database, at any point in this project's history.
Every real deployment of this application — this test database included
— was necessarily built by `npm run db:push` (which builds tables
directly from the Drizzle TypeScript schema, bypassing all `.sql`
migration files, including 0013's CHECK constraint and trigger).

**Decision.** Rather than attempt a full migration-path repair as a
prerequisite to hardening (out of scope for this fix and too risky to do
unreviewed against data that already exists), 0013's DDL was applied
directly and idempotently via a small guarded script
(`backend/scripts/apply-0013-guarded.cjs`, run as
`DATABASE_URL=postgresql://... node backend/scripts/apply-0013-guarded.cjs`)
that:

- Checks `pg_constraint` for `ck_remaining_kg_nonnegative` before adding
  it (Postgres has no `ALTER TABLE ADD CONSTRAINT IF NOT EXISTS`), and
  additionally verifies zero existing rows would violate it before
  applying — an unguarded `ALTER TABLE ADD CONSTRAINT` validates every
  existing row and fails outright if any violates it.
- Uses `CREATE OR REPLACE FUNCTION` for `fn_ledger_entries_append_only`
  (already idempotent by construction).
- Uses `DROP TRIGGER IF EXISTS` followed by `CREATE TRIGGER` for
  `trg_ledger_entries_append_only`, since `CREATE TRIGGER IF NOT EXISTS`
  does not exist in PostgreSQL either.

This achieves the exact same end state 0013 intends, safely re-runnable,
without depending on a migration runner that cannot currently apply even
its own first migration.

**Verified live** (before → after, direct DB queries):
- `pg_constraint` CHECK constraints on `rolls`: 0 → 1
  (`ck_remaining_kg_nonnegative`, definition `CHECK (remaining_kg >= 0)`).
- Triggers on `ledger_entries`: 0 → 1
  (`trg_ledger_entries_append_only`, enabled).
- Functional proof, not just existence: a direct `UPDATE rolls SET
  remaining_kg = -5` was rejected with the constraint's own error message;
  a direct `DELETE FROM ledger_entries` was rejected
  ("is append-only: DELETE not allowed"); a direct `UPDATE` changing
  `debit` outside a cancellation was rejected ("UPDATE only allowed for
  cancellation"); a legitimate cancellation (`status → 'cancelled'`,
  `cancelled_at` set, no financial columns touched) succeeded and left
  `debit`/`credit` unchanged; a second cancellation attempt on the same
  now-cancelled row was rejected ("cannot modify already-cancelled
  rows").

**What this decision does NOT do.** It does not repair `0001_initial.sql`
or restore the migration journal — that is a separate, larger body of
work (rewriting 23 `CREATE POLICY IF NOT EXISTS` statements and adding
statement breakpoints throughout) that was out of scope for this pass and
carries its own risk against a database that already has real data. Any
future migration-path repair must account for the fact that `db:push` is
the schema of record today, not the `.sql` files.

**Known, deliberately out-of-scope observation from this same review.**
While reading `fn_ledger_entries_append_only()` to verify it, a
pre-existing logic gap was confirmed by inspection (not separately
live-tested in this session, since it was not part of the task at hand):
the function compares nullable columns (`party_id`, `reference_id`,
`reference_type`) with `<>` instead of `IS DISTINCT FROM`. In SQL,
`NULL <> NULL` evaluates to `NULL` (not `TRUE`), so for any ledger row
where one of those columns is `NULL` (every non-party contra leg —
`cash`, `sales_revenue`, `cogs_expense`, `inventory_asset`,
`opening_equity`, etc.), a cancellation-shaped `UPDATE` could in
principle also silently change that nullable column without tripping
the "financial columns are immutable" check. This is exactly what the
function is supposed to prevent for those rows. Flagged here rather than
silently patched, since it was not part of the requested C-4/C-5/C-7/C-8
scope for this session and deserves its own live before/after
verification pass.

---

## D-002 — C-4, C-5, C-7 applied as coded (transaction/lock/batch-balance fixes, no sign or schema decisions)

Brief entries for completeness — none of these required a sensitive
direction decision the way C-8 did, so they are logged here mainly for
the audit trail rather than because a judgment call needed recording.

- **C-4** (`PostgresLedgerRepository.cancelByReference`): added a
  transactional Postgres advisory lock keyed by
  `(tenantId, referenceType, referenceId)` plus a pre-insert check for an
  existing `type = 'cancellation'` row for that reference. Live-verified:
  a duplicate cancel call on the same reference now returns
  `409 ALREADY_CANCELLED` instead of inserting a second (and, on a third
  call, geometrically compounding) set of reversal rows. See the fix
  commit on `fix/ledger-cancel-idempotent` for the full live before/after
  transcript.
- **C-5** (`PostgresStatementRepository.settle`): wrapped the balance
  read and the settlement insert in one transaction holding a
  `FOR UPDATE` lock on the party row.

  **Update — definitively confirmed, both directions.** The first pass
  reported an honest negative: 2-way, same-tick `Promise.all`, and 8-way
  parallel requests at real network timing could not force a double-spend
  on either the original or the fixed code in this low-latency local
  Postgres instance — the race window is real by inspection, just too
  narrow to lose reliably at real timing. That result was correctly
  flagged as inconclusive rather than treated as proof either way,
  and a follow-up review asked, correctly, whether the "before" case
  had actually been exercised on the pre-fix code specifically (it had —
  via `git stash` reverting the file, confirmed by grep — but the
  negative result alone still didn't prove the vulnerability, only that
  it couldn't be forced by timing).

  To settle this conclusively, the pre-fix code was temporarily restored
  (`git stash`/manual revert) with a 300ms artificial delay inserted
  between the balance SELECT and the settlement INSERT — deterministically
  widening the exact window the static read identified, rather than
  relying on real network jitter. Under that widened window:
  - **Original (pre-fix) code + 300ms delay**: two genuinely parallel
    `Promise.all` requests against a customer with balance 5,235,000 SYP
    BOTH succeeded, each posting a full settlement of 5,235,000. Final
    balance: **-5,235,000** instead of 0 — the double-spend, reproduced
    on demand.
  - **Fixed code + the same 300ms delay in the same place** (inside the
    transaction, after the `FOR UPDATE` lock, before the insert): the
    first request succeeded (settled 5,158,000); the second was rejected
    with `"الرصيد صفر لا يحتاج تسوية"` because it blocked on the lock,
    then re-read the now-zero balance after the first committed. Final
    balance: **0**, exactly.

  The diagnostic delay was reverted immediately after each side of the
  test (`git checkout --` on the file), confirmed via `git diff HEAD`
  returning empty — no diagnostic code was left in the shipped fix. This
  is now a genuine, deterministic before/after proof, not just a
  structurally-correct-but-unconfirmed fix. See `fix/statement-settle-atomic`.
- **C-7** (`writeLedgerUseCase`): added a per-currency
  Σdebit = Σcredit check across the whole batch (grouped by currency,
  never summed across currencies), in addition to the pre-existing
  per-entry single-sidedness check. Live-verified: a single-entry
  5,000,000 debit-only batch that previously inflated a customer's
  balance is now rejected; a batch balanced only when SYP and USD are
  summed together is also rejected; a genuinely balanced same-currency
  batch still succeeds. See `fix/ledger-batch-balance`.
