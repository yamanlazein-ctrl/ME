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

*(Further decisions — C-4, C-5, C-7, C-8 — appended below as each is
completed.)*
