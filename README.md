# Motard Fabrics Group ERP

Arabic-language ERP for fabric & roll trading. Monorepo: React frontend, an Express API with two database
engines (PostgreSQL for the sync hub, SQLite for the Windows desktop app), a Tauri desktop shell, and a shared domain.

## Monorepo Layout

| Directory          | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `src/`             | Web frontend — TanStack Start + React 19 (Arabic UI, RTL)                  |
| `backend/`         | REST API — Express, Drizzle ORM, Zod; PostgreSQL (hub) + SQLite (desktop)  |
| `packages/shared/` | Single source of truth — Zod schemas, entities, `is2dp`, money helpers     |
| `public/`          | Static assets                                                              |
| `tests/e2e/`       | Playwright + API E2E                                                       |
| `scripts/`         | Ops helpers (backup/restore, ledger integrity)                             |
| `docs/`            | Delivery docs (decisions, sync ops, disaster recovery)                     |
| `desktop-app/`     | Windows desktop shell v3 (Tauri 2 / Rust) — design in `desktop-app/ADR.md` |
| `admin-dashboard/` | License / activation admin panel                                           |

## Features

- **Inventory** — fabrics, colors, rolls (kg), stock movements, `costPerKg` snapshot
- **Invoices** — sale/entry, `subtotal - discount + tax + shipping`, every line and total through `round2dp` (exact decimal, half away from zero — the same as PostgreSQL `ROUND`), partial `paid`, cancellation
- **Returns** — sale/entry returns with `rollId` aggregation, `pricePerKg` server-derived, `cost` split, currency check
- **Vouchers** — receipts/payments, `cash` leg correctly `debit`/`credit`, `invoices.paid` maintained transactionally
- **Ledger** — double-entry, 20 `type` values, append-only trigger, `FORCE RLS`
- **Cashbox** — `close-day` derived from `ledger` (only `date/counted/currency` from client)
- **Dashboard** — profit `subtotal-discount` and `costPerKg` snapshot (not live `rolls.price`)
- **Parties** — customers/suppliers, `openingBalance` journaled both signs
- **Auth & RBAC** — JWT HS256 + `jti`, Argon2id 64MiB/t=3/p=4, `tenantId` required, `NOBYPASSRLS`
- **Multi-tenant** — `withTenantTx` `SET LOCAL`, `FORCE RLS`, `missing_ok`

## Tech Stack

- **Package manager / runtime (DFP-032):** **npm** + `package-lock.json` are the release source of truth. CI and Desktop staging use **Node 22**. Do not use `bun.lock` for customer builds.
- **Frontend:** React 19, TanStack Start/Router/Query, Tailwind 4, Zod, `is2dp` from `@erp/shared`
- **Backend:** Node 22, Express, Drizzle, Zod via `@erp/shared`, `bigint` money, `withTenantTx`
- **Shared:** `@erp/shared` — `precision`, `money`, 6 Zod schemas, `Invoice/Party/Roll/Fabric` helpers, `contracts` `z.infer`
- **Company logo sync (DFP-035):** binary logo upload (`POST /api/company/logo`) is **device-local** until attachment sync ships; profile text fields still sync via `PUT /api/company/profile`. Expect different logos on peer devices until then.

## Deployments and data safety

| Deployment                       | Engine                               | Notes                                                                            |
| -------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Windows desktop (`desktop-app/`) | SQLite (`DB_ENGINE=sqlite`)          | Bundled Node backend on a per-launch named pipe inside a Job Object; no TCP port |
| Sync hub (web / Render)          | PostgreSQL, FORCE row-level security | Started with `HUB_PREPARE_ON_BOOT=1`                                             |

**Desktop data root.** Customer data lives only in `%LOCALAPPDATA%\MotardERP\` (program files in
`%LOCALAPPDATA%\Motard ERP\`, replaced by every update). The shell guarantees:

- a database is created only on an empty data root; keys are never silently regenerated next to data;
- before a new version first opens existing data it takes a verified copy (`backups\pre-update\`) and
  pins it as the rollback point — retries of a failing update reuse it;
- a restore from the recovery screen is journaled (`restore-pending.json`): if the archive is refused or
  the shell dies, the previous company is put back instead of an empty one;
- moving a company aside is journaled (`.moving.json`); an interrupted move is undone at the next start;
- only the process holding `motard.lock` starts a backend or touches data files;
- a factory reset requires the typed phrase in the shell itself; the WebView's storage is cleared after
  any company change.

**Restore inside a running backend** is a whole-application transition: sync cycles are drained and
paused during the swap, every repository follows the reopened connections, cached idempotent responses
of the previous database are dropped, the identity cache is cleared, and the restored counts become the
data-integrity baseline. A restored device's new sync identity is persisted before it is registered and
gets its own hub credential.

**Google Drive archive.** Settings → Google Drive links the company's Google account (its own OAuth
"Desktop app" client). The shell keeps the refresh token (DPAPI) and pushes short-lived access tokens
to the backend, which uploads the month exports and the newest verified backup from the primary
device. Details: `desktop-app/ADR.md` → "Google Drive archive".

**Updates.** Manual installer updates by design (owner decision, audit C-03): run the newer installer
over the installed one. There is no online updater and no update action in the UI; the data is never
touched and a verified pre-update copy is taken on the first start of the new version.

**Hub security.** Start-up runs `migrate` → `apply-rls` (the canonical `enable-rls.sql` layer) →
`verify-rls`; a hub whose isolation contract fails does not serve. Every path that adds a sync device
obeys the licence device limit.

## Quick Start

```bash
# 1) Install
npm install
cd backend && npm install

# 2) Infra (or local PG/Redis)
cd backend && docker compose up -d postgres redis

# 3) Env
cp .env.example .env
cd backend && cp .env.example .env  # edit DATABASE_URL, JWT_SECRET (≥32), REDIS_URL, APP_MASTER_KEY

# 4) DB (fresh)
cd backend && npm run db:migrate

# 5) Run
cd backend && npm run dev   # http://localhost:8080  (health: /api/health/live)
npm run dev                 # http://localhost:5173  (VITE_API_BASE_URL=http://localhost:8080)
```

First run: open `http://localhost:5173`, complete one-time device activation, then sign in with the admin created during setup (or seed a **local test** admin via `NODE_ENV=test E2E_ADMIN_PASSWORD=… node backend/seed-test-admin.mjs`). Reset admin password: `node backend/scripts/reset-admin-password.mjs`. Do **not** commit reusable passwords (DFP-029).

## Scripts

| Command                                                                   | Description                              |
| ------------------------------------------------------------------------- | ---------------------------------------- |
| `npm run dev`                                                             | Vite dev                                 |
| `npm run build`                                                           | Production build                         |
| `npx vitest run`                                                          | Frontend + `packages/shared` tests       |
| `cd backend && DB_ENGINE=sqlite npx vitest run`                           | Backend suite on SQLite (desktop engine) |
| `cd backend && DATABASE_URL=… npm test`                                   | Backend suite on PostgreSQL (hub engine) |
| `npx tsc --noEmit` · `cd backend && npx tsc --noEmit`                     | Type checks                              |
| `cd backend && npm run typecheck:sqlite`                                  | SQLite schema + fingerprint gate         |
| `npm run lint` · `cd backend && npm run lint`                             | Lint (0 warnings allowed)                |
| `cd backend && npm run db:migrate`                                        | Apply migrations                         |
| `cd backend && node scripts/apply-rls.mjs && node scripts/verify-rls.mjs` | Apply / verify the RLS layer             |
| `cd desktop-app/src-tauri && cargo test -j1`                              | Desktop shell tests                      |
| `cd desktop-app && npm run build:installer`                               | Stage + build the Windows installer      |

## Environment

**Root `.env` (`.env.example`):**

| Variable            | Default                 | Description                            |
| ------------------- | ----------------------- | -------------------------------------- |
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend URL (single `getApiBaseUrl()`) |
| `VITE_REPO_MODE`    | `api`                   | `api` only                             |

**Backend `backend/.env.example`:**

| Variable         | Default                                        | Description                 |
| ---------------- | ---------------------------------------------- | --------------------------- |
| `DATABASE_URL`   | _(required — local example in `.env.example`)_ | PG connection string        |
| `REDIS_URL`      | `redis://localhost:6379`                       | Required in `production`    |
| `JWT_SECRET`     | —                                              | ≥32 chars                   |
| `CORS_ORIGIN`    | `http://localhost:5173`                        | Refuses `*` in `production` |
| `APP_MASTER_KEY` | —                                              | Base64 32 bytes             |

## Architecture

```
Presentation (routes, middleware)  —  auth → RLS via withTenantTx
Infrastructure (repositories, drizzle, redis)
Application (use-cases, ports)     —  Zod via @erp/shared
Domain (entities via @erp/shared, money bigint, events)
```

`@erp/shared` is the single source for `is2dp`, `money`, Zod schemas, and entity helpers. No `className`/`markup` changes were made (design constraint).

## Verification

Results on 2026-10-14 (after the Hermes audit remediation):

| Suite                                                                 | Result                                           |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| Frontend (`npx vitest run`)                                           | 100 files, 433 tests passed                      |
| Backend on SQLite                                                     | 186 files passed (10 skipped), 1010 tests passed |
| Backend on PostgreSQL (disposable cluster)                            | 197 files, 1057 tests passed                     |
| Desktop shell (`cargo test`)                                          | 28 passed                                        |
| `tsc` (root, backend), `typecheck:sqlite`, lint, `prettier --check .` | clean                                            |
| `verify-rls.mjs` on a hub database prepared as a non-superuser owner  | OK — 51 tables, all policy families              |

## License

Private — all rights reserved.
