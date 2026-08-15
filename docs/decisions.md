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
  `FOR UPDATE` lock on the party row. **Honest result, not omitted**:
  live concurrency testing (2 parallel requests, then same-event-loop-tick
  `Promise.all`, then 8-way parallel) could NOT force a double-spend on
  either the original or the fixed code in this environment — the
  window is real (no transaction, no lock, verified by inspection) but
  too narrow for this low-latency local Postgres instance to lose
  reliably under test. The fix was applied anyway because the code
  defect is unambiguous and inconsistent with every sibling financial
  write path; the negative concurrency result is recorded rather than
  claimed as a positive live confirmation it isn't. See
  `fix/statement-settle-atomic`.
- **C-7** (`writeLedgerUseCase`): added a per-currency
  Σdebit = Σcredit check across the whole batch (grouped by currency,
  never summed across currencies), in addition to the pre-existing
  per-entry single-sidedness check. Live-verified: a single-entry
  5,000,000 debit-only batch that previously inflated a customer's
  balance is now rejected; a batch balanced only when SYP and USD are
  summed together is also rejected; a genuinely balanced same-currency
  batch still succeeds. See `fix/ledger-batch-balance`.

## D-003 — C-8: unified the supplier balance sign to match invoices/vouchers, not the other way around

**This is the single most consequential code change in the whole fix
protocol** — it changes the sign of every supplier's running balance —
so per the explicit instruction for this item, nothing below was
assumed correct from reading the code. Five running-balance scenarios
were hand-computed on a calculator *before* touching any file, then
checked against the live system twice: once against the original code
(to confirm the bug is real, not a misreading), and once against the
fixed code with a brand-new supplier (to confirm the fix, not just the
absence of the old bug).

**The three conflicting conventions found by re-reading the actual
write paths** (not assumed from the prior audit — re-verified fresh
this session):
1. `PostgresPartyRepository.create()` — opening balance: **flips**
   debit/credit by `isCustomer` (supplier gets `credit = opening`).
2. `PostgresInvoiceRepository.create()` — invoice party leg: **always**
   `debit = total`, for both sale AND purchase invoices — no
   customer/supplier branching at all.
3. `PostgresVoucherRepository.create()` — voucher party leg: **always**
   `credit = amount`, for both receipt AND payment — no
   customer/supplier branching at all (comment: "Vouchers always CREDIT
   the party account").
4. `PostgresStatementRepository.getStatement()` — reads with
   `mult = kind === "customer" ? 1 : -1` (flips for supplier).
5. `PostgresLedgerRepository.getBalance()` /`getBalanceByDate()` — reads
   with plain `debit - credit`, **no flip at all**, for either party
   kind.

Two out of three writers (invoices, vouchers — the overwhelming
majority of ledger volume) already treat debit/credit uniformly for
both party kinds. Only the opening-balance writer disagreed with them.
Compounding that, two of the two balance READERS disagreed with each
other (one flips for suppliers, one never flips) — meaning, before this
fix, `GET .../suppliers/:id/statement` and `GET /api/ledger/balance/:id`
could show *opposite signs* for the very same supplier at the very same
instant.

**Hand-computed ground truth** for a supplier: opening 1000 (we owe
them), +500 purchase, -300 payment, +200 purchase, -100 payment.
True running balance: 1000 → 1500 → 1200 → 1400 → 1300.

**Live result on the original code** (a real supplier, real invoices,
real vouchers, via the actual HTTP API — not inferred):
statement `finalBalance`: 1000 → 500 → 500 → 400 → 500 (exact sequence
affected by an extra purchase created while debugging an unrelated
voucher-schema mistake in the test harness; see the fix commit for the
full six-row transcript) — moving in the OPPOSITE direction from ground
truth on every purchase/payment after the opening row.
`ledger.getBalance`: exactly the negative of the statement's number at
every single step (1000 vs -1000, 500 vs -500, etc.) — proving the two
balance-reading endpoints actively disagreed with each other, not just
with reality.

**Decision.** Make debit/credit uniform for both party kinds, matching
the convention invoices and vouchers already use everywhere:
- `PostgresStatementRepository`: `mult = 1` unconditionally (removed the
  customer/supplier branch).
- `PostgresPartyRepository.create()`: opening balance is now always
  `debit = openingBalance` on the party leg (removed the `isCustomer`
  branch) — matching the "debit increases what's owed" convention the
  invoice writer already uses for both sale and purchase.
- `PostgresLedgerRepository.getBalance()`/`getBalanceByDate()` needed
  **no code change** — their plain `debit - credit`, once the writer
  above stops flipping, is already the correct uniform formula. This
  was verified by hand before editing anything, not assumed.

**Live result on the fixed code**, brand-new supplier, same five-step
scenario: statement and `ledger.getBalance` both read 1000 → 1500 →
1200 → 1400 → 1300 — an exact match to the hand-computed ground truth
at every step, and the two endpoints agree with each other at every
step (they did not, before).

**Regression, customers**: unaffected by design (customers were never
flipped by any of the three writers) and confirmed live — an existing
customer's balance is byte-for-byte unchanged, and a brand-new customer
with a 700 opening balance correctly reads +700 on both endpoints.

**Known, deliberately unresolved consequence — read before touching any
real deployment.** This fix is prospective. It does not rewrite any
`type = 'opening'` ledger row already written for an existing supplier
under the old (flipped) convention. Live-proven, not theoretical: the
SAME test supplier used to reproduce the bug above, re-queried *after*
the fix was restored, now reads `-500` on **both** endpoints (the
cross-endpoint disagreement is gone — that part of the fix applies
universally, since it only changes how existing debit/credit numbers
are *read*) but `-500` still does not match that supplier's true
ground-truth balance of `1500`, because its stored opening row still
physically contains the old `credit = 1000` instead of `debit = 1000`.

**Before this fix is applied to any database holding real supplier
data**: every existing supplier with a non-zero opening balance needs a
one-time, explicitly-reviewed data migration that swaps `debit` and
`credit` on its `type = 'opening'` ledger row (and the matching
`opening_equity` contra row). This was intentionally NOT done
automatically as part of this code fix — it touches existing financial
records for real counterparties, which is exactly the kind of change
this protocol's escalation rules require a human decision on, not an
autonomous one. Until that migration runs, any supplier that already
has an opening balance will show an incorrect (though now at least
*self-consistent* across both balance endpoints) figure after this
code ships. Suppliers with no opening balance, and every transaction
that happens after this fix ships, are unaffected and correct
immediately.
