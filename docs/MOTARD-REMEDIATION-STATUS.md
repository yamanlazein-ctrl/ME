# MOTARD remediation — implementation status

What was actually changed, why, and how each item was proven. Every "FIXED"
entry below has a test or a live-database verification behind it; unproven
items are listed separately and honestly.

## P0 defects found by running the code (not in the original plan)

These were discovered only because the production migration path and the live
test suites were executed for real. All three were shipping bugs.

### P0-A — every fresh install aborted mid-migration

`20260924_unified_device_identity.sql` backfilled with
`UPDATE "sync_devices" s SET ... FROM LATERAL (SELECT ... WHERE d.tenant_id = s.tenant_id ...)`.
PostgreSQL does not expose the UPDATE target row to a FROM-clause LATERAL item,
so the statement raised *invalid reference to FROM-clause entry for table "s"*
and aborted the whole run. Every migration after it never applied, and
`drizzle-kit migrate` reported nothing.

**Fix** — correlated scalar subquery with an `EXISTS` guard.
**Proof** — all 74 migrations now apply on a clean database, and a re-run is a
no-op. A guard test fails if the LATERAL form returns.

### P0-B — JWT revocation silently stopped working

`20260923_force_rls_all_tenant_tables.sql` enabled **and forced** RLS on every
public table with a `tenant_id` column. `revoked_tokens` has a nullable
`tenant_id` and **no policy**, and FORCE RLS applies even to the table owner —
so `SELECT ... FROM revoked_tokens` returned zero rows and `isRevoked(jti)`
always answered "not revoked". Logout, forced session revocation and the token
cutoff were all inoperative; a revoked token stayed valid until natural expiry.

**Fix** — `20260927_revoked_tokens_no_rls.sql` disables RLS on the denylist, and
the blanket sweep now excludes it with the reasoning recorded inline.
**Proof** — reproduced live (0 rows visible to a non-owner role, 1 row present),
then verified readable after the migration.

### P0-C — conflict resolution always failed

`resolveSyncConflict` built its `resolution` JSON with untyped placeholders, so
PostgreSQL answered *could not determine data type of parameter $3*. The catch
block turned that into `return null`, so the operator UI could never resolve a
conflict and nothing was logged at error level.

**Fix** — explicit `::text` casts (also in `resolveSyncConflictByOp`).
**Proof** — the live conflict-resolution suite passes.

### P0-D — an applied claim locked its resource forever

A settled (applied/dead) identity claim row passed the pre-check but still
violated `uq_sync_claims_identity` on insert; the catch reported the settled
holder as a live conflict. Every later settlement or party update on that
resource returned a 409 that could never clear.

**Fix** — settled identity rows are released before insert.
**Proof** — `sync-identity-claims` and `sync-claim-release` pass live.

## Plan items

| ID | Item | Status | Proof |
| --- | --- | --- | --- |
| FIN-01 | One executed money formula | FIXED | Schema refinements, repo `update()`, both entry screens and both line helpers now call `@erp/shared`; parity suites green |
| FIN-02 | Dead client invoice counter | FIXED | `nextInvoiceNumber` deleted; no client-fabricated number reaches the create payload |
| FIN-03 | `tenants.activation_id` FK | FIXED | `20260926_tenant_activation_fk.sql`; constraint verified live |
| FIN-04 | `device_registrations.user_id` in ORM | FIXED | Column + index declared; schema-parity test green |
| FIN-06 | Silent `drizzle-kit migrate` failure | FIXED | `backend/scripts/migrate.mjs` fails loudly; verified non-zero exit with printed cause. It is what exposed P0-A |
| FIN-07 | Migration prefix traps | FIXED | Prefix-uniqueness guard with the historical `0020_` duplicate allowlisted |
| FIN-08 | Behavioural sync proof | PARTIAL | Harness repaired (see below) and wired into CI as **advisory** |
| FIN-09 | Vacuous live-suite passes | FIXED | `databaseReachable()` makes an unreachable DB a hard failure when `DATABASE_URL` is set; four suites now self-seed |
| FIN-12 | Remote font dependency | FIXED | IBM Plex Sans Arabic self-hosted via `@fontsource` in both apps; zero `fonts.googleapis.com` references; build green |
| FIN-13 | Weak browser fingerprint | FIXED | Desktop activation now fails closed instead of falling back to the UA-based hash; the fallback is documented web-only |
| FIN-17 | FX `null` swallowed as `0` | FIXED | Voucher cancel no longer subtracts an unconverted cross-currency amount from `invoices.paid`; the fx gain/loss leg refuses to post when either side cannot be restated in base currency |
| FIN-18 | Silent license-identity failure | FIXED | Failure recorded and surfaced through `/api/health/deep` instead of a warn |
| FIN-19 | Two numbering systems | CONFIRMED-KEEP | Tip reconciliation carves above the shared sequence |
| FIN-21/22/23/25 | Voucher-cancel, cashbox, rollback, quantity claims, pull exclusion | CONFIRMED-KEEP | Re-inspected against current code; the earlier audit text was stale |

## Multi-device sync drill (FIN-08)

Three real bugs in the harness were fixed, which is why it had never gated
anything:

1. It read secrets only from a `.env` file and ignored real environment
   variables, so in CI it minted a JWT with an `undefined` key and died before
   the first scenario.
2. It passed a raw string to `jose` instead of the encoded key.
3. It seeded only the legacy `sync_devices.authorized_user_ids` array. Migration
   `20260922` moved that authority into `sync_device_authorized_users`, and the
   repository overwrites the array from that table — so every device call
   answered `403 SYNC_DEVICE_NOT_BOUND`.

After the fixes the drill reaches **27/33**, and convergence, no-loss,
no-duplication, ordering, cursor-tie handling and lease recovery all pass.

It is wired into CI as **advisory, not blocking**, because repeated runs on
identical code scored 27, 21, 27 and 17: the drill reuses a template database
and leaks state between scenarios. Making a non-deterministic script a required
gate would fail honest pull requests at random. Promote it to blocking after the
template is rebuilt per run.

## Verification performed

- Frontend/shared: **175 passed, 6 skipped**.
- Backend against real PostgreSQL 16: **404 passed, 0 failed** (was 9 failing,
  all of which had previously been hidden by vacuous skips).
- All 74 migrations apply on a clean database; re-run is a no-op.
- `tenants_activation_id_fk`, `device_registrations.user_id` and the live
  fingerprint unique index confirmed present in the database.
- Frontend and admin dashboard both build.
- Frontend and backend typecheck clean.

## Still NOT proven (needs hardware or a real environment)

- DFP-004 packaged Windows lifecycle — clean VM + signed installer.
- DFP-020/021 installer and service behaviour — real installer artifact.
- DFP-023 two-device convergence on physical machines — the drill proves the
  protocol against three databases, not two real machines on a network.
- DFP-024 control-plane license server — externally hosted.
- DFP-027 brand icon — placeholder asset.
- Physical print certification — WebView2 output on a real printer.
