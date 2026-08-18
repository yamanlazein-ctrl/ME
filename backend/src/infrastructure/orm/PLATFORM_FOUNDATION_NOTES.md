# Platform Foundation — Implementation Notes

**Audience:** the implementing agent for sub-batches 0A → 0K.
**Source of truth:** `.kilo/plans/1785336483290-licensing-and-platform-foundation-plan.md`
**Validation report:** `.kilo/plans/1785336483290-validation-report.md`

This file captures the **specific decisions** made during 0A-prep that the
implementing agent must respect. It is NOT a replacement for the plan.

---

## 1. Audit strategy (resolved in 0A-prep.2)

- `audit_logs` (existing) is **kept as-is** for general business change tracking
  (invoices, expenses, returns, vouchers). 4 route groups already write to it.
- A new `license_audit_events` table is added in sub-batch 0C for license,
  security, and admin events. It is a separate table, not a rename of `audit_logs`.
- The `IAuditRepository` port gains `list` / `query` methods in 0C so
  `PostgresDashboardRepository` can stop bypassing the port.
- A global `audit.middleware.ts` is added in 0C; it must **skip** the 4 routes
  that already write audits via use-cases to avoid double-writes.

## 2. RLS strategy (resolved in 0A-prep.3)

- The shared-pool `SET SESSION` pattern in `tenant.middleware.ts` is **racy**
  and is **not** the right foundation for new code. It stays for the
  migration period but is no longer the recommended path.
- New code (license, setup, secrets, devices) **must** use
  `withTenantTx(tenantId, async (tx) => ...)` from
  `src/infrastructure/orm/drizzle.ts`.
- All new tables added in sub-batches 0A → 0J use:
  ```sql
  ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;
  ALTER TABLE <name> FORCE ROW LEVEL SECURITY;        -- bypass even for table owner
  CREATE POLICY <name>_tenant_isolation ON <name> FOR ALL
    USING       (tenant_id = current_setting('app.current_tenant_id')::UUID)
    WITH CHECK  (tenant_id = current_setting('app.current_tenant_id')::UUID);
  ```
- The new policies go in `0002_platform_foundation.sql` (or a
  `0002_rls.sql` applied alongside) as raw SQL appended to the
  drizzle-generated migration.
- A migration-time helper to apply RLS to all newly-created tables
  (or retroactively to existing ones) should be added as part of 0A.

## 3. Tenant schema additions (planned for 0A)

The existing `tenants` table has only `license_key` (VARCHAR(255), nullable)
and `license_expires_at` (TIMESTAMPTZ, nullable). The 0A migration adds:

| Column               | Type          | Notes                                       |
|----------------------|---------------|---------------------------------------------|
| `license_status`     | VARCHAR(20)   | `active` \| `trial` \| `expired` \| `suspended` \| `revoked` |
| `license_type`       | VARCHAR(20)   | `trial` \| `full` \| `subscription`         |
| `max_devices`        | INTEGER       | default 3                                   |
| `activation_id`      | UUID          | links to the active `license_activations` row |
| `server_fingerprint` | VARCHAR(128)  | SHA-256 hex of the host's machine signals   |
| `last_heartbeat_at`  | TIMESTAMPTZ   | updated by the heartbeat middleware         |

These columns live on `tenants` (the existing plan said "1 license ↔ 1 tenant"
and the `tenants` table is the parent of all business data). The full
`licenses` table is a separate concern (history, transfers) — see 0E.

## 4. Authentication for bootstrap (resolved in 0A-prep.5)

- The `Role` union is **NOT** extended. There is no `superadmin` / `owner`
  role. Adding one would touch every `rbac([...])` call site (15+ files).
- Bootstrap admin creation goes through `POST /api/setup/init`, gated by
  a `SETUP_TOKEN` env var. The endpoint accepts an `X-Setup-Token` header
  (or a `setup_token` body field for the SSR initial-load case) and rejects
  if the token does not match `config.SETUP_TOKEN`.
- `SETUP_TOKEN` is **required in production** (`NODE_ENV=production`).
  In development it is optional — the dev mode is permissive so the wizard
  can be exercised without setup ceremony.
- The first Owner user is created with `role="admin"` (existing value).
  No role-union change is required.

## 5. License Server deployment (resolved in 0A-prep.6)

- The License Server is a **separate entrypoint**: `src/scripts/license-server.ts`.
  It is NOT a `LICENSE_SERVER_MODE` branch inside `buildContainer()`.
- `LICENSE_SERVER_MODE=server npm run license-server` boots the License Server.
- `LICENSE_SERVER_MODE=off` (default) boots the customer install. The customer
  install does NOT import any license-server-only modules, so the two
  deployments are isolated at the module level.
- The full License Server implementation lands in sub-batch 0J. The current
  entrypoint is a stub that fails fast with a clear error.

## 6. License token signing (resolved in 0A-prep.7)

- `JWT_SECRET` (HS256) is used **only** for user access/refresh tokens.
- License offline tokens are signed with `LICENSE_SIGNING_KEY` (Ed25519 by
  default, see the env example for generation instructions).
- The customer install only needs `LICENSE_SIGNING_PUBLIC_KEY` to verify
  tokens. The private key is held only by the License Server.
- The two signing realms (user JWT vs license JWT) use different keys AND
  different algorithms, so a leak of one cannot impersonate the other.

## 7. Frontend DI skeleton (planned for 0A-prep.8)

The frontend gets the same DI skeleton for licenses as for every other
domain. See `src/application/ports/ILicenseRepository.ts` (added in 0A-prep.8)
plus the in-memory + API implementations to follow in 0I.

## 8. AuthGate ↔ Setup Wizard coexistence (planned for 0F)

The current provider chain is:
```
QueryClientProvider → ThemeProvider → AuthGate → ErrorBoundary → Outlet
```

In 0F, an `InstallGate` is inserted BEFORE `AuthGate`:
```
QueryClientProvider → ThemeProvider → InstallGate → AuthGate → ErrorBoundary → Outlet
```

`InstallGate` queries `GET /api/setup/status`. If the wizard is incomplete
(returns `{ isCompleted: false }`), the gate renders the wizard (or redirects
to `/setup/*`) and bypasses `AuthGate` entirely.

## 9. Auth state unification (planned for 0A-prep.10)

Today the frontend has two parallel sources of "current user":

- `useAuthState()` in `src/lib/auth.ts` — reads from the in-memory
  `settings.users` array via `localStorage["erp.auth.userId"]`.
- `useTenantContext()` in `src/infrastructure/di/auth-context.ts` — reads
  the JWT from `localStorage["erp.auth.accessToken"]`.

0A-prep.10 unifies these: `useAuthState` becomes a thin wrapper around the
`IAuthRepository`. The JWT (when present) is the source of truth; when
absent, the in-memory mock is the dev fallback.

The JWT write path (`localStorage["erp.auth.accessToken"]`) is added in
`IAuthRepository.login()` so successful logins actually persist a token.

---

## 10. Schema baseline decisions (resolved in sub-batch 0A)

### 10.1. `secrets` columns use `text` (not `bytea`)

Drizzle's `customType` quotes user-defined data types in the generated
DDL (`"bytea"` with quotes). Postgres accepts this (case-insensitive
identifier resolution) but it is fragile and looks like a syntax error
to anyone hand-reading the migration.

Phase 0 stores ciphertext/iv/auth_tag as `text` columns (base64-encoded
buffers). Trade-off: +33% storage size, but portable across drivers,
no quoting surprises, and the natural format for already-encrypted
strings (the JwtSigner stores JWS strings, not raw bytes).

If a future sub-batch needs raw binary, the `bytea` column can be added
with a hand-written ALTER TABLE that uses an unquoted `bytea` type.

### 10.2. `tenants` column-extension is hand-appended to 0002

Drizzle's diff between the TS schema and the snapshot is empty for the
new `tenants` columns because the snapshot already includes them (the
snapshot represents the **end state** of 0002, not the start).

A real DB that applied the original hand-written `0001_initial.sql` does
NOT have these columns. To make 0002 the single source of truth for
both the new tables and the new tenant columns, the
`ALTER TABLE "tenants" ADD COLUMN ...` statements are appended
explicitly to `0002_platform_foundation.sql`, after the auto-generated
DDL. They use `IF NOT EXISTS` so a re-run is safe.

### 10.3. `licenses` and `secrets` allow NULL `tenant_id`

Both tables hold rows that exist **before** a tenant is established:

- `licenses`: a license key is created by the License Server before any
  customer activates it. The row has `tenant_id = NULL` and is
  visible to all tenants for status checks.
- `secrets`: system-level secrets (JWT signing key, master-key
  fingerprint) have `tenant_id = NULL`. Tenant-specific secrets
  (per-tenant license offline tokens) have a tenant id.

The RLS policy on these tables is:
```sql
USING      ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID))
WITH CHECK ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID));
```

The four "strict" tables (`license_activations`, `device_registrations`,
`company_profiles`, `setup_wizard_state`) use a plain
`tenant_id = current_setting(...)` policy with no NULL allowance.

### 10.4. `license_audit_events` is append-only at the DB level

A trigger raises on `UPDATE` and `DELETE`, returning the
`insufficient_privilege` SQLSTATE. Even direct psql access cannot
tamper with the audit log. Inserts are unrestricted so the middleware
can write events without setting any GUC (the policy allows NULL
tenant_id for system-level events).

### 10.5. `license_activations` enforces one-active-per-license

A partial unique index:
```sql
CREATE UNIQUE INDEX "idx_license_activations_one_active"
  ON "license_activations" ("license_id")
  WHERE "deactivated_at" IS NULL;
```

This is the application-level invariant (AD-5) pushed into the DB so
even a buggy use-case cannot violate it. Drizzle does not support
partial indexes declaratively; the index is created in the migration
SQL.

### 10.6. Drizzle-kit version pinning

`drizzle-orm@0.36.4` and `drizzle-kit@0.31.4` are intentionally
mismatched (the newer `drizzle-orm` provides fixes that the older
`drizzle-kit` cannot consume at a higher major). Versions are pinned
exact in `backend/package.json` so future installs do not drift.

All `db:*` npm scripts route through `tsx node_modules/drizzle-kit/bin.cjs`
so the TypeScript imports in the schema files (with `.js` extensions)
resolve correctly at runtime.

### 10.7. Snapshot strategy

- The snapshot (`meta/0002_snapshot.json`) represents the **end state
  of 0002** (i.e., all 32 tables as defined by the TS schema files).
- `npx tsx node_modules/drizzle-kit/bin.cjs check` passes (`Everything's fine`).
- A re-run of `generate` produces an empty diff (verified during 0A).
- The journal marks `0001_initial` with `when: 0` so drizzle-kit treats
  it as already applied — for new DBs, the 0001 SQL still needs to be
  applied manually OR replaced with a drizzle-generated one (not in
  Phase 0 scope; documented in 0A's commit message).
