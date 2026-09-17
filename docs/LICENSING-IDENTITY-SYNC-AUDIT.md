# StoneERP — Licensing, Identity & Offline-First Sync: Audit & Fix Report

Scope: audit the **existing** codebase (`backend/`, `desktop/`,
`admin-dashboard/`) against the Licensing / Identity-and-Invitations /
Offline-First-Sync spec, fix the broken relationships first, stabilise
migrations, fix bugs, and add tests.

This document is written to be **traceable**: every claim below is either backed
by a command you can re-run or by a file:line reference.

---

## 0. How the findings were verified (re-runnable)

| Check | Command | Result |
|---|---|---|
| Migrations apply to a **fresh** database | `cd backend && npm run db:test:setup` | ✅ creates DB, applies all **66** migrations, 48 tables |
| Migration journal ↔ disk parity | `cd backend && npx vitest run tests/migrations-journal-guard.test.ts` | ✅ 66 journal entries == 66 `.sql` files |
| ORM schema ↔ migration parity | `npx vitest run tests/schema-migration-parity.test.ts` | ✅ every declared column is created by some migration |
| Backend typecheck | `cd backend && npm run typecheck` | ✅ 0 errors (was 2 — see §3.4) |
| Full backend suite | `cd backend && npm run test` | 43 files: **38 passed / 5 failed**; 322 tests: **308 passed / 3 failed / 11 skipped** |
| Live schema relationships | `node tmp-fk-audit.mjs erp_test` (scratch, since removed) | FK/NOT NULL dump quoted in §2 |

### Baseline vs now

| | Files failed | Tests failed |
|---|---|---|
| Before (as cloned) | **11** of 42 | 4 |
| After provisioning the missing test DB | 8 | 8 |
| After the fixes in §3 (fresh DB) | 6 | 3 |
| Final (incl. the new hermetic tests in §3.6) | **5** of 43 | 3 |

Note the difference between the last two rows: on a **fresh** DB the failures
are `no tenant` preconditions; once the DB has rows (as on any developer
machine), `device-identity-link` / `fx-cogs-replay-pin` / `phase8` /
`session-cutoff` run — which is precisely the non-hermetic behaviour §7
describes. The final 5 are all ambient-state suites:

1. `audit-findings.test.ts` — needs the live API on `127.0.0.1:8080`
   (`ECONNREFUSED`).
2. `session-cutoff.test.ts` — needs a tenant row.
3. `device-identity-link.test.ts` — needs matching synced device/license rows.
4. `sync-conflicts-resolve.test.ts` — failed with `expected undefined to be
   'resolved'`; see the pool-GUC analysis in §7.
5. `sync-identity-claims.test.ts` — an earlier holder's claim still blocks.

Every previously-failing **hermetic** guard (`sync-invariants` F-07 and voucher
P5) is green, and the 9 new hermetic tests in §3.6 pass without a database.

---

## 1. Executive summary

The three subsystems in the spec are **already implemented** and, in the sync
case, implemented to a higher standard than the spec asked for (durable outbox,
first-write-wins resource claims, an explicit conflict ledger — *not*
last-write-wins). So this was **not** a greenfield build and I did not treat it
as one.

What was actually broken, in priority order:

1. **The test database `erp_test` was never provisioned anywhere in the repo.**
   `backend/vitest.config.ts` loads `.env.test`, which points at `erp_test`, but
   nothing created it. A fresh checkout failed **11 of 42** test files with
   `database "erp_test" does not exist` (SQLSTATE `3D000`). Fixed: new
   `backend/scripts/ensure-test-db.mjs` + `npm run db:test:setup`.
2. **The License ↔ Invitation association was dead.**
   `invitation_codes.license_id` exists with an FK to `licenses.id`, but **no
   code path ever wrote it**, so the column was always `NULL` and the link the
   spec relies on (§5, §9.1) did not exist in practice. Fixed in §3.1.
3. **Invitation redemption wrote an invalid foreign key.** Device registration
   fell back to a hardcoded all-zeros UUID
   (`00000000-0000-0000-0000-000000000000`) for `license_id` — a `NOT NULL`
   column with an FK to `licenses.id`. Redeeming a device invitation (or a user
   invitation carrying a device fingerprint) therefore threw FK violation
   `23503` and surfaced the generic "فشل استهلاك رمز الدعوة". Fixed in §3.2.
4. **A broken build:** `setupUseCases.ts` computed the spec's Step-2 company name
   ("Welcome, Al-Noor Company") on the activation response, but the declared
   return type omitted `companyName`, so `npm run typecheck` failed. Fixed in §3.4.
5. **Two invariant tests had gone stale** after `invoice.route.ts` /
   `voucher.route.ts` were refactored onto a shared failure-response helper. The
   *behaviour* is correct (the helper emits `SYNC_OUTBOX_FAILED`); only the
   text-based assertions no longer matched. Fixed in §3.3 — strengthened rather
   than weakened (the helper's own contract is now asserted).

Plus one operational hazard worth knowing about (§4.3): **`drizzle-kit migrate`
fails completely silently.** Proven by instrumenting its bundled progress view.
---

## 2. The data model as it actually exists

Verified against the **migrated schema** (`tmp-fk-audit.mjs erp_test`), not just
the Drizzle definitions:

```text
tenants
  id (PK)
  owner_user_id  -> users.id          [FK EXISTS in DB, NOT DECLARED in the ORM]
  activation_id                        [uuid, NO FK AT ALL]
  license_key / license_expires_at / license_status / license_type ...
                                       [denormalised cache of the license]

users
  tenant_id      -> tenants.id  NOT NULL   (scoped: every user belongs to 1 tenant)
  is_license_owner                         (second "owner" signal — see §2.1)

licenses
  tenant_id      -> tenants.id  NULL       (null = system-level, pre-activation)
  key (unique), customer_name, ...

license_activations                        <- the REAL license <-> tenant link
  license_id     -> licenses.id NOT NULL
  tenant_id      -> tenants.id  NOT NULL
  UNIQUE (license_id) WHERE deactivated_at IS NULL  ("one active per license")

invitation_codes
  tenant_id      -> tenants.id  NOT NULL
  license_id     -> licenses.id NULL       [dead before this change — §3.1]
  created_by     -> users.id    NOT NULL

device_registrations
  license_id     -> licenses.id NOT NULL   [source of the nil-UUID bug — §3.2]
  tenant_id      -> tenants.id  NOT NULL
  user_id        -> users.id    NULL       [FK EXISTS in DB, NOT declared in ORM]
  device_fingerprint (unique per tenant)

sync_devices                               <- the sync transport identity
  tenant_id      -> tenants.id  NOT NULL
  last_seen_by_user_id -> users.id         (a transient actor, NOT authority)
  authorized_user_ids  uuid[]              (the users the device is provisioned for)
  revoked_at / revoke_reason
  device_fingerprint (unique per tenant)
```

The canonical chain the spec describes resolves to:

```text
License --(license_activations, 1 active)-- Tenant(Company)
Tenant --(users.tenant_id)------------------ User(role)  [Owner: is_license_owner]
Tenant --(invitation_codes.tenant_id)------- Invitation --(license_id)--> License
Invitation --(redemption)------------------> User (+ device_registrations.license_id)
Tenant --(sync_devices.tenant_id)----------- Device  [authorized_user_ids]
```

### 2.1 Associations that are broken, missing or duplicated

| # | Association | State | Impact |
|---|---|---|---|
| A | `invitation_codes.license_id` | FK existed, **never written** | License <-> Invitation link absent; the spec's §5.1 "invitation belongs to the company/license" was only implicit via `tenant_id` |
| B | `device_registrations.license_id` | FK enforced, code passed a **placeholder** | FK violation on redemption; device invitations unusable |
| C | `tenants.activation_id` | **no FK** | A dangling activation id is possible; the tenant→activation edge is unenforced |
| D | `tenants.owner_user_id` | FK in DB, **absent from the ORM schema** | ORM/DB drift; `drizzle-kit generate` would want to drop it |
| E | `device_registrations.user_id` | FK in DB, **absent from the ORM schema** | drift; the registration never records *which* user's device it is |
| F | `tenants.owner_user_id` **vs** `users.is_license_owner` | two sources of truth for "the owner" | nothing guarantees they agree |

C/D/E/F are **reported, not silently "fixed"**: each needs a product decision
(§9). Changing D/E means regenerating Drizzle snapshots, and F needs a rule for
which one wins. A and B are unambiguous data-integrity defects and are fixed.
---

## 3. Fixes made (each traceable to a test or a typecheck)

### 3.1 License <-> Invitation: the dead FK is now stamped (A)

`generateInvitationCodeUseCase` resolves the tenant's license
(`licenseRepo.findLatestForTenant`, tenant-GUC stamped exactly like the
pre-auth consume path does) and persists it to **both**
`invitation_codes.license_id` (the FK) **and** `metadata.licenseId` (kept for
backwards compatibility).

- `backend/src/application/use-cases/invitation/invitationUseCases.ts` — new
  `licenseRepo` parameter; license resolution documented at "Section 5.1".
- `backend/src/application/ports/IInvitationRepository.ts` — `create()` input
  and `InvitationRow` gained `licenseId: UUID | null`.
- `backend/src/infrastructure/repositories/PostgresInvitationRepository.ts` —
  persists and returns `licenseId`.
- `backend/src/presentation/routes/invitation.route.ts` — passes
  `container.licenseRepo` (which it already held for the consume path).

Why not fail when a tenant has no license? Generation must stay usable for
tenants whose license row has not landed yet (e.g. pre-baked desktop flows);
the enforcement point is redemption, where a device *must* be bound (§3.2).

### 3.2 Redemption: no more placeholder license id (B)

`consumeInvitationCodeUseCase` now resolves the license as
`lic?.id ?? row.licenseId`. When a device registration is required (a "device"
invitation, or a "user" invitation redeemed with a device fingerprint) and no
real license exists, it **refuses outright** —

> لا يوجد ترخيص مرتبط بهذه الشركة — تعذّر تسجيل الجهاز بهذه الدعوة

— *before* any user/device row is written, so a rejected redemption leaves no
partial state. The device is then registered against the resolved id, never
against an invented one. Besides the FK violation, the old code was a latent
cross-tenant leak: had a row with the all-zeros id ever existed, devices would
have been silently bound to a license that is not their tenant's — exactly the
mis-association pattern §7 of the spec forbids.

### 3.3 Stale outbox-failure guards are updated, not deleted

`invoice.route.ts` and `voucher.route.ts` were the only two of the nine
enqueuing routes missing the literal `SYNC_OUTBOX_FAILED`. Inspection showed
this was **not a code gap**: both delegate to the shared
`respondTransactionFailure(...)` helper
(`backend/src/infrastructure/http/transactionRouteError.ts`), whose default
`syncCode` is `"SYNC_OUTBOX_FAILED"` (it only returns `VALIDATION` for real
business-rule / day-locked failures — still a hard, non-2xx answer).

- `backend/tests/sync-invariants.test.ts` — the F-07 "hard error" assertion now
  accepts the helper form *and* a new assertion pins the helper's default code,
  so the delegation cannot become a loophole. The voucher P5 assertion got the
  same treatment.
- Result: the two failing guards are green again, and the guard set is
  **stronger** than before (+1 assertion, static, no DB needed).

### 3.4 Activation response now declares the company name

`activateAndPersistUseCase` built the spec's Step-2 response
(`companyName` from `licenses.customer_name`, falling back to
`vendor_metadata.companyName`) but the declared `Result` type omitted it, so
`tsc --noEmit` failed:

- `backend/src/application/use-cases/setup/setupUseCases.ts` — `companyName?:
  string | null` added to the activation result type with a Section-3 note.
- Fixing my own addition in the same check:
  `PostgresInvitationRepository.create()` needed `licenseId` on its inline
  input type. Final: **0 type errors**.

### 3.5 Test DB provisioning (root cause of the 11 setup failures)

New `backend/scripts/ensure-test-db.mjs` (+ `npm run db:test:setup`):

1. resolves `DATABASE_URL` from `.env.test` (falling back to `.env`),
2. creates the database when missing (idempotent),
3. applies every committed migration with drizzle-orm's own migrator — the same
   code path `drizzle-kit migrate` uses, but with the failure surfaced on
   stderr instead of swallowed.

Verified from scratch (drop → re-provision): `created database erp_test`,
48 tables. Also added `"test": "node scripts/ensure-test-db.mjs && vitest
run"` so a fresh checkout can go from zero to a green-runnable suite in one
command.
### 3.6 New hermetic tests: the invitation ↔ license contract

New `backend/tests/invitation-license-link.test.ts` (9 tests, **no database** —
every dependency is a closure fake). These are the first tests that pin the
contract this pass repaired, and they run even on a machine with no Postgres:

| Test | What it locks in |
|---|---|
| `generate` stamps the license on row + metadata | License → Invitation → Device is one connected chain |
| `generate` leaves `licenseId` null with no license | generation stays usable pre-activation (§3.1) |
| device redemption, no license anywhere | **fails closed**; `registerDevice`, `consume`, `createUser` all 0 calls — no FK violation, no partial state |
| device redemption, license only on the row | registers against the *stamped* license, then consumes |
| user redemption with device, no license | refuses before creating the user |
| validate: unknown / revoked / expired / used | the four redemption states stay explicit |

### 3.7 Scratch tooling used for the audit (all removed)

`tmp-make-db.mjs`, `tmp-db-state.mjs`, `tmp-schema-inventory.mjs`,
`tmp-fk-audit.mjs`, `tmp-run-migrations.mjs`, `tmp-replicate-dk.mjs`,
`tmp-dk-wrapper.cjs`, `tmp-drizzle-debug.config.mjs` and the temp `erp_probe*`
databases were created to reproduce and diagnose, then **deleted** (verified:
no `tmp-*` remains in `backend/`, and no reference to them survives in `src/`,
`tests/`, `scripts/` or `package.json`).

---

## 4. Migration audit

### 4.1 Journal, files, and schema are mutually consistent

- **66 journal entries == 66 `.sql` files**, no orphans in either direction
  (`migrations-journal-guard.test.ts` — covers both the 0046 `pin_hash` and the
  0058 `sync_tombstones` historical incidents).
- Journal `idx` is a dense 0..n-1 sequence, `when` strictly ascending.
- Every column the Drizzle schemas declare is created by some migration
  (`schema-migration-parity.test.ts`).
- A **fresh** database migrates cleanly with both the ORM migrator and
  `drizzle-kit migrate`: 48 tables in `public`, bookkeeping in
  `drizzle.__drizzle_migrations` (66 rows), exit 0. Fresh-DB reproduction used a
  `erp_probe*` database so no working data was touched.

### 4.2 Cosmetic numbering quirks (not bugs)

- Two files share the `0020_` prefix (`0020_add_pieces_field.sql` and
  `0020_performance_indexes_and_balance_cache.sql`). Ordering comes from
  `meta/_journal.json`, never from the filename, so this is only a readability
  trap — worth a rename the next time a migration is authored.
- There is no `0057_*` file (0056 → 0058). Harmless: filenames are labels, the
  journal is the order.

### 4.3 Real hazard: `drizzle-kit migrate` fails silently

Reproduced: a mis-targeted `DATABASE_URL` made `npm run db:migrate` exit **1**
with **nothing on stdout or stderr** — just one last spinner frame reading
`[⣷] applying migrations...`. Root cause is in the bundled `hanji` progress
view (`renderWithTask`): on rejection it renders the view's `"rejected"` state
— which for the migrate view is the *same string* as the pending state — and
calls `process.exit(1)` without ever printing the error. I confirmed the
underlying error by temporarily instrumenting the view in `node_modules` (cause
chain: `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` ← `3D000
database ... does not exist`), then **reverted the instrumentation** (verified:
no `TEMP-DEBUG` remains in `node_modules/drizzle-kit/bin.cjs`).

Consequences for this project:

1. Any real migration failure on a developer machine or in CI will present as
   "it just didn't run", inviting `db:push` workarounds on live databases.
2. The failure was invisible to the journal/parity guards (both passed the whole
   time) because they test the *files*, not the *CLI run*.

Mitigation in place: `db:test:setup` surfaces migrator errors on stderr
explicitly. Recommended next step: do the same for the real `db:migrate` path
(e.g. a thin repo-owned `scripts/migrate.mjs` wrapper that runs the migrator
and prints failures) rather than relying on the CLI's presentation layer.
---

## 5. Flow-by-flow review vs the spec

### §2 — Licensing (Vendor Dashboard). ✅ implemented
`admin-dashboard/` (license issue/list) + `license-admin` routes
(`backend/src/presentation/routes/`, `licenseUseCases.ts`). The vendor enters
company name/duration/edition/seats/modules; a `LIC-*` key is issued and
`customer_name` is stored on the license row — the single source for the
activation greeting (§3.4 above).

### §3 — First-run activation. ✅ implemented, one type fixed
Key → license validated → company name from the license (never typed) → device
PIN (`users.pin_hash`, Argon2, 4-digit) → confirmed → ERP opens. No separate
"Company Setup"/"Tenant Setup" screen sits on the *first-run activation path*
(`activateAndPersistUseCase` → `recordDesktopDeviceActivation`).

⚠️ **Deviation to confirm:** the codebase *also* ships a multi-step setup
wizard (`saveCompanyStepUseCase`, `saveAdminStepUseCase`,
`saveReviewStepUseCase`, `completeWizardUseCase`). If the spec's "no company
setup screen" is literal for all entry points, the wizard is out of scope and
should be gated to operator-only provisioning; if the wizard is the intended
*admin* path, the spec needs one sentence saying so. I did not remove or alter
it — including its C-3 hardening (`assertWizardMutable`, no re-promotion on a
completed tenant), which is correct and should stay.

### §4 — Day-2 re-entry. ✅ implemented
Activated devices are recognised from local state + heartbeat; the license/PIN
screens are not re-shown. (Server-side: `license_activations` + tenant license
cache + `syncTenantLicenseCache`; device trust in `sync-device-gate`.)

### §5 — Identity & invitations. ✅ implemented, association repaired, 1 gap
Generate (`/api/invitations/generate`, admin-guarded, roles
`admin|accountant|warehouse|viewer`, 1–1440 min TTL) → accountant enters the
code on their own device → validate shows the company → role assigned →
redeemed **into the same `tenant_id`** (tenant is taken from the invitation
row, never from caller input — this is the correct same-tenant behaviour, and
`invitation-tenant-scope.test.ts` + `rls-guard.test.ts` pin the scoping of
revoke). Redemption states (invalid / revoked / expired / already-used) are all
handled explicitly in `validateInvitationCodeUseCase` /
`consumeInvitationCodeUseCase`.

❌ **Gap:** the spec's suggested owner notification
("Mohammed has joined Al-Noor Company as Accountant") is **not implemented**.
The `notifications` table + `kind='sync'` machinery exists, so this is a small,
well-scoped addition — listed in §9 for a decision.

### §6 — Offline-first sync. ✅ implemented to a higher bar than asked

The engine is hub-spoke: each device keeps a **durable outbox**
(`sync_outbox`) fed **inside the same transaction as the business write**
(F-07 `withTenantTx`; verified statically by `sync-invariants.test.ts`), and a
hub mirror (`sync_inbox`). See §6 for the actual conflict strategy — the short
version is: **no silent overwrite, anywhere.**

### §7 — Tenant isolation. ✅ enforced at the data layer
- `FORCE RLS` on all tenant tables, stamped via `app.current_tenant_id` at
  connection checkout (`TenantScopedPool` reads the request's ALS context —
  never a pooled-session `SET`).
- Invitation redemption stamps the invitation's own tenant; `revoke`/`consume`
  are `(id, tenantId)`-scoped; `findByCode` is a deliberate platform read whose
  writes re-anchor to the row's tenant.
- `users.tenantId` is NOT NULL with a per-tenant unique email; a join can only
  ever land in the invitation's tenant (§5), so the "Accountant → Tenant B"
  failure mode from the spec cannot be produced through this flow.
---

## 6. Conflict-resolution strategy as implemented (recommendation: keep it)

Answering the spec's §6.2 design questions from the code (`syncEnqueue.ts`,
`syncConflicts.ts`, `syncMaterialize.ts`, `docs/SYNC-OPERATIONS.md`):

- **Default for concurrent edits on the same record: conflict is surfaced, not
  resolved.** An update carries the `baseVersion` the device read; if the hub
  is at a different version the unit is rejected into the **`sync_conflicts`
  ledger** with `localIntent`, `baseVersion`, `serverVersion`, and the hub
  version is never overwritten. Resolution is explicit and closed by decision:
  `keep-server`, `withdraw`, or `rebase` (a *new* edit through the normal
  update path — the conflict row never mutates the invoice itself).
- **For numeric/financial contention: first-write-wins resource claims, not
  version checks.** Selling the same roll, or touching the same stock/finance
  resource, requires a `sync_resource_claims` row with quantities (kg **and**
  pieces). A competing op is rejected with a reason (`held` when a live winner
  holds the stock, `insufficient-stock` when the roll is genuinely short), and
  the losing device **reconciles locally**: created documents are cancelled
  locally, updates/cancels stay flagged for manual re-entry against the
  winning version, and a `kind='sync'` notification names what happened.
- **Idempotency (§6.2 question 2):** the hub dedupes on `(tenant_id, op_id)`;
  materialisation is idempotent; `rejected`/`dead` are terminal; a redelivered
  unit is a no-op. Retries after a dropped connection are safe.
- **Ordering (§6.2 question 3):** 4 push lanes — lane 0 carries
  masters/orders/ledger/settlements/cashbox/settings/company in recorded order
  (parents first); lanes 1–3 are hashed by document for
  invoices/returns/vouchers/expenses so a same-document chain stays ordered
  while independent documents drain concurrently. Missing dependencies make the
  unit retryable, not dead; `syncDependencySnapshots` captures the parents.
- **Same-record edit (§6.2 question 4):** surfaces as a conflict row per the
  first bullet — deliberately never "last writer silently wins".

Trade-offs, stated plainly: (a) losers do manual re-entry — slower than an
automatic merge, but nothing financially material is ever auto-overwritten;
(b) claims add a reservation round-trip online (offline creates fall back to
claimed number blocks / local units that the hub judges on push); (c) the
ledger is a reconciliation queue someone must actually work — the runbook
(`SYNC-OPERATIONS.md`) owns that process. Given this is a financial system, I
recommend keeping this model and **not** adopting LWW or field-level auto-merge
for money/stock — at most, auto-rebase could later be added for provably
disjoint fields, with the ledger kept as the audit trail.
---

## 7. Remaining test results, classified with evidence

Current: **38/43 files, 308/322 tests green.** The 5 remaining failures are
**not product bugs** — each is a test whose precondition is *ambient database
(or server) state*, so its outcome changes with what happens to be in the DB:

| Failing suite | Error | Classification |
|---|---|---|
| `audit-findings.test.ts` | `ECONNREFUSED 127.0.0.1:8080` | **Live-API E2E in a unit file.** Needs the backend running on :8080 with seeded data — run it as E2E (`npm run test:integration`), not in `vitest run`. |
| `session-cutoff.test.ts` | `no tenant on live postgres` (empty DB) | **Needs a provisioned tenant.** No fixture creates one. |
| `device-identity-link.test.ts` | `no matching fingerprint …` / `no tenant` | **Needs pre-existing synced device + license rows.** Nothing seeds them. |
| `sync-conflicts-resolve.test.ts` | `expected undefined to be 'resolved'` | Non-hermetic **and** suspected harness bug — see below. |
| `sync-identity-claims.test.ts` | an *earlier* holder's claim still blocks the second | Shares one DB with no isolation/cleanup; outcome depends on run order and leftovers. |

Two runs on different DB states make the non-hermetic point unambiguous:

- **Empty, freshly migrated DB** → these suites abort on their `no tenant / no
  invoice` preconditions (or *pass vacuously* — see next paragraph).
- **Populated DB** → they actually test, and the failure set *changes*
  (`fx-cogs-replay-pin` and `phase8` flip from red to green purely because rows
  now exist).

The sharpest instance: `sync-conflicts-resolve.test.ts` **passes on an empty
DB without testing anything** (`if (!reachable) return;` after a `LIMIT 1`
tenant lookup) and fails when a tenant exists, at
`expect(kept?.status).toBe("resolved")`. Suspected mechanism (not yet proven):
the test sets `app.current_tenant_id` with `pool.query("SELECT
set_config(...)")`, which lands on **one arbitrary pooled connection**, while
`recordSyncConflict`/`listSyncConflicts`/`resolveSyncConflict` may check out
*different* connections without the GUC — the exact race `tenant-context.ts`
warns about. RLS would then hide the just-written row, so `listed.find(...)`
returns `undefined`. If confirmed, the fix belongs in the *test* (fixture
tenant + `runWithTenantContext`, never a pool-level `SET`). This is the first
test to harden next, because it guards the §6 conflict path.

Recommended direction (needs your call): mark every ambient-state suite
explicitly (e.g. `describe.skipIf(!process.env.E2E_DB)`) or — better — give
them self-contained fixtures (create tenant + license + device inside the
file, delete afterwards). Until then, the honest reading is: **the hermetic
core is green; the data-dependent suites are environment reports, not unit
results.**
---

## 8. Requested spec test coverage — status

| Spec §9.5 item | Status |
|---|---|
| First-run activation: valid / invalid / expired key | Provider enforces valid/invalid/revoked/expired (`SelfHostedLicenseProvider`: unknown key → `INVALID_LICENSE`; `revoked`/`expired` status → `LICENSE_REVOKED`/`LICENSE_EXPIRED`); `license.route.ts` maps bad key → 400 and revoked/expired → 403. No dedicated hermetic activation-path test yet — covered today by live E2E (`licensing-lock-in.spec.ts`). |
| PIN create/confirm mismatch | 4-digit rule enforced at consume; `pin_hash` flow; `0046_user_pin_hash` journal guard |
| Day-2 silent re-entry | Implemented (activation/device trust/heartbeat); no re-prompt logic verified at code level |
| Invitation: valid / invalid / expired / already-used | All four branches explicit in `validate`/`consume`; `invitation-tenant-scope.test.ts` pins cross-tenant revoke |
| Tenant isolation (join lands in the same tenant) | Enforced: tenant comes from the invitation row; repo scopes `(id, tenantId)` |
| Offline write → reconnect → both devices converge | `sync-invariants`, `restore-sync-state`, multidevice scripts; hub dedupes on `(tenant_id, op_id)` |
| Concurrent offline edits to the same record | No silent overwrite (§6); `sync_conflicts` ledger + `sync-conflicts-resolve.test.ts` — currently non-hermetic, see §7 |

---

## 9. Open questions / decisions needed

1. **Setup wizard vs "no company setup screen"** (§5 intro): keep the wizard as
   the operator path, or gate/remove it? Its C-3 takeover hardening is correct
   either way.
2. **`tenants.activation_id`**: add the missing FK to `license_activations(id)`
   (migration + ORM), or remove the column if nothing reads it?
3. **ORM drift (`tenants.owner_user_id`, `device_registrations.user_id`)**:
   declare them in the Drizzle schemas (recommended) and regenerate the
   snapshot, so `db:check`/`generate` stop disagreeing with reality.
4. **Owner identity**: pick one source of truth (`tenants.owner_user_id` or
   `users.is_license_owner`) and backfill the other — or document that one is
   a cache of the other.
5. **Owner-join notification** (§5 suggestion): implement via the existing
   `notifications` table on `consume` (small, recommended), or drop from scope?
6. **Live-data suites (§7)**: gateway them behind an env flag, or fund the
   fixture work to make them hermetic?
7. **`db:migrate` error surfacing (§4.3)**: accept a repo-owned migrate wrapper
   so migration failures are never silent again?

## 10. Files changed in this pass

- `backend/src/application/ports/IInvitationRepository.ts` — `licenseId` on
  `InvitationRow` and `create()` input.
- `backend/src/infrastructure/repositories/PostgresInvitationRepository.ts` —
  persist/return `licenseId`; `create()` input type extended.
- `backend/src/application/use-cases/invitation/invitationUseCases.ts` —
  license stamping at generate; fail-closed license binding + real license id
  at consume (nil-UUID fallback removed).
- `backend/src/presentation/routes/invitation.route.ts` — pass
  `container.licenseRepo` to generate.
- `backend/src/application/use-cases/setup/setupUseCases.ts` —
  `companyName?: string | null` on the activation result (§3 Step 2).
- `backend/scripts/ensure-test-db.mjs` (new) + `backend/package.json`
  (`db:test:setup`, `test`) — reproducible test-DB provisioning.
- `backend/tests/sync-invariants.test.ts` — F-07 + voucher P5 guards updated
  for the shared helper; helper contract pinned (+1 assertion).
- `backend/tests/invitation-license-link.test.ts` (new) — 9 hermetic tests for
  the invitation ↔ license binding contract and the four validate states (§3.6).
- `docs/LICENSING-IDENTITY-SYNC-AUDIT.md` (this file).

Verification after all changes: `npm run typecheck` → 0 errors; `npm run test`
(provisions the DB, then vitest) → the §7 baseline above, with every
previously-failing *hermetic* guard green and the 9 new hermetic tests passing.