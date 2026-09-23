# MOTARD ERP — Implementation Report

## Scope

Executed the critical implementation work from `COMPREHENSIVE-IMPROVEMENT-PLAN.md` in dependency order. No commit or push was performed. The existing working tree was preserved; changes were made in place.

## Completed and verified

### Stage -1 — build and correctness recovery

- Fixed backend syntax error in `backend/src/presentation/server.ts` (`rows[0]?.id`).
- Restored missing return-calculation declarations in `PostgresReturnRepository.ts` (`isEntryReturn`, `saleTotal`, `costTotal`).
- Fixed frontend invoice type cleanup so returns remain separate return documents rather than an unsupported invoice type.
- Added `page` to `InventoryFilter`.
- Fixed party page loading to send `page` instead of unsupported `offset`.
- Restored `README.md` and the original `docs/decisions.md` content.
- Reverted the unapproved `Number.EPSILON` change in `round2dp` to the established behavior.
- Fixed the idempotency middleware TypeScript signature.
- Added integrity-control endpoint exemptions to sync coverage.

### Data safety and SAFE_MODE

- SAFE_MODE now permits only authentication/session endpoints and the integrity control plane while continuing to block business mutations.
- Integrity verification failures now enter SAFE_MODE instead of being silently skipped.
- Corrupt/ unreadable integrity manifests are no longer treated as an ordinary first install when the manifest file exists.
- Accept-baseline now re-collects and persists current counts/database size, clears reset state, and returns the accepted baseline.
- Restore rejects backups containing warnings before any target deletion.

### Restore safety

- Removed `ON CONFLICT DO NOTHING` from restore inserts so skipped rows become hard failures.
- Removed the committed wipe-before-insert boundary: delete, insert, sequence/cursor checks, and final invariants now remain in the same pending transaction until the final commit.
- Restore syntax was checked successfully.

### Synchronization

- Outbox finalization methods now require a lease token, require `status='pushing'`, and return affected-row counts.
- The push path refuses units without a lease token and uses the claimed token for all finalization calls.
- Stale workers cannot finalize a reclaimed unit through the guarded update predicates.
- Pull cursor writes are monotonic and cannot move the cursor backwards during concurrent updates.

### Completeness and search

- Restored report detail aggregation inputs from the accidental `limit: 50` regression to the previous bounded `limit: 1000` behavior while the full server-side aggregation migration is pending.
- Corrected search SQL escape literals to preserve literal `%`, `_`, and backslash handling.

## Verification performed

- Backend TypeScript: **PASS** (`npx tsc --noEmit -p .`).
- Frontend TypeScript: **PASS** (`npx tsc --noEmit -p .`).
- Frontend Vitest: **48 files / 216 tests passed**.
- Backend Vitest with disposable PostgreSQL and migrations: **84 files / 487 tests passed**.
- Targeted backend regressions: **20 tests passed** including returns, FX/COGS replay, integrity manifest, restore sync state, schema parity, and sync coverage.
- Desktop `cargo check`: **PASS**.
- Desktop `cargo test`: **62 passed / 0 failed**.
- Disposable PostgreSQL was used for backend live tests; no customer database was used.

## Not yet proven or fully completed

The complete plan is broader than the repairs completed in this pass. The following remain release blockers or require additional implementation/evidence:

1. Durable `financial_operations` operation records with replayed response/request-hash semantics. Current route idempotency and document operation IDs are not yet the final one-to-many settlement design.
2. Full staging-database restore with database/filesystem atomicity, attachments checksums, encryption/key custody, and restore drill.
3. Desktop non-superuser application role and proof that RLS is enforced in the bundled runtime.
4. Full report migration to server-side aggregates and real pagination/typeahead across all screens; `limit: 1000` remains a temporary compatibility bound in some consumers.
5. Exhaustive occurrence audit for all broad list loads, `ILIKE` sites, and aggregation over paginated data.
6. Performance/load measurements at declared dataset tiers; no ten-year or arbitrary-load claim is made.
7. Hub snapshot/bootstrap/compaction for long-term sync retention.
8. Full transaction-boundary inventory and all lock-order/deadlock scenarios.
9. Backup scheduler/automatic artifact verification, retention policy, off-device encrypted backup, and RPO/RTO drills.
10. Packaged Windows upgrade/install/rollback/power-loss matrix.
11. Rust warning cleanup (`IntegrityManifestLite` private-interface warning).
12. A fresh packaged desktop build and installation test have not been run.

## Release decision

```text
Gate -1: PASS for typechecks and currently runnable test suites.
Gate A: NOT COMPLETE.
Gate B: PARTIAL.
Gate C: NOT COMPLETE.
Gate D: NOT COMPLETE.
```

The current tree is materially healthier and all available automated suites pass, but it must not yet be described as 100/100, ten-year-ready, or proven for arbitrary production load until the remaining release blockers above are implemented and measured.
