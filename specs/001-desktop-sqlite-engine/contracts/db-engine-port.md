# Contract: Database Engine Boundary (backend-internal)

**Consumers**: application use cases and routes, through `application/ports/I*Repository`.
**Providers**: `Postgres*Repository` (cloud, unchanged) and `Sqlite*Repository` (desktop, new).

## Selection

| Input | Values | Default | Set by |
|---|---|---|---|
| `DB_ENGINE` env | `postgres` \| `sqlite` | `postgres` | Desktop runtime sets `sqlite`. Cloud sets nothing. |
| `DATABASE_URL` | PostgreSQL URL | required when `postgres` | cloud only |
| `SQLITE_PATH` | absolute path to `motard.db` | required when `sqlite` | desktop runtime, after the lock is granted |

- `infrastructure/di/container.ts` instantiates exactly one family of repositories.
- Each engine's driver module is loaded lazily, so the `postgres` path never loads `better-sqlite3` and the
  reverse is also true.
- If both or neither required input is present, the backend refuses to start with a fatal log, and never falls back.

## Guarantees every provider MUST meet (verified by the shared conformance suite)

1. **Same port signatures and results.** For identical inputs and state, a port method returns deep-equal
   results on both engines: money as `number` with identical values, timestamps as `Date`, ids as
   lower-case UUID strings, and the same ordering.
2. **Transactions.** `withTenantTx(tenantId, fn)` and `db.transaction(fn)`:
   - run `fn` atomically;
   - give `fn` read-your-writes;
   - turn nested calls into savepoints;
   - roll back fully on throw.

   SQLite: `BEGIN IMMEDIATE` behind the single write gate (research R3).
3. **Tenant scoping.** Every read and write is limited to the context tenant. PostgreSQL enforces it with RLS plus predicates,
   SQLite with predicates. The isolation suite seeds two tenants and must observe zero leakage.
4. **Errors.** Constraint violations surface as the same `persistenceErrorMessage` codes
   (`23505`, `23503`, `23502`, `23514`, `22P02`) and the same user text.
5. **Transaction clock.** Every `defaultNow()` value written in one transaction is equal (PostgreSQL `now()` semantics).
6. **No caps.** A provider adds no `LIMIT` the PostgreSQL provider does not have. Keyset cursors order by the
   same keys `(created_at, id)`.
7. **Session flags.** `allowLedgerPartyRemap(tx)` and the dye-purge bypass are scoped to the transaction and
   cleared on commit and rollback.

## Out of contract

- Raw SQL text, and query plans and indexes beyond correctness. Performance is measured separately (OQ-4).
