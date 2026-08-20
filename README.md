# Motard Fabrics Group ERP — Production Ready

Arabic-language ERP for fabric & roll trading. Monorepo: React frontend, Express + PostgreSQL API, and shared domain.

## Monorepo Layout

| Directory | Purpose |
|-----------|---------|
| `src/` | Web frontend — TanStack Start + React 19 (Arabic UI, RTL) |
| `backend/` | REST API — Express, Drizzle ORM, PostgreSQL 16+, Redis, Zod |
| `packages/shared/` | Single source of truth — Zod schemas, entities, `is2dp`, money helpers |
| `public/` | Static assets |
| `tests/e2e/` | Playwright + API E2E (including `verify-all-fixes`) |
| `scripts/` | Verification tooling |

## Features

- **Inventory** — fabrics, colors, rolls (kg), stock movements, `costPerKg` snapshot
- **Invoices** — sale/entry, `subtotal - discount + tax + shipping` with per-line `Math.round`, partial `paid`, cancellation
- **Returns** — sale/entry returns with `rollId` aggregation, `pricePerKg` server-derived, `cost` split, currency check
- **Vouchers** — receipts/payments, `cash` leg correctly `debit`/`credit`, `invoices.paid` maintained transactionally
- **Ledger** — double-entry, 20 `type` values, append-only trigger, `FORCE RLS`
- **Cashbox** — `close-day` derived from `ledger` (only `date/counted/currency` from client)
- **Dashboard** — profit `subtotal-discount` and `costPerKg` snapshot (not live `rolls.price`)
- **Parties** — customers/suppliers, `openingBalance` journaled both signs
- **Auth & RBAC** — JWT HS256 + `jti`, Argon2id 64MiB/t=3/p=4, `tenantId` required, `NOBYPASSRLS`
- **Multi-tenant** — `withTenantTx` `SET LOCAL`, `FORCE RLS`, `missing_ok`

## Tech Stack

- **Frontend:** React 19, TanStack Start/Router/Query, Tailwind 4, Zod, `is2dp` from `@erp/shared`
- **Backend:** Node 22, Express, Drizzle, Zod via `@erp/shared`, `bigint` money, `withTenantTx`
- **Shared:** `@erp/shared` — `precision`, `money`, 6 Zod schemas, `Invoice/Party/Roll/Fabric` helpers, `contracts` `z.infer`

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

First run: open `http://localhost:5173`, the setup wizard at `/api/setup/status` creates the `bootstrap` tenant, then `admin@erp.local` / `admin123` (tenant `407fccfc-ba89-41c5-b5b9-ddb2c4f385d9` in dev seed) can log in. For `fix-admin` scripts: `ADMIN_BOOTSTRAP_PASSWORD=... node backend/scripts/fix-admin.mjs --force`.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev |
| `npm run build` | Production build |
| `npm run typecheck` | Frontend `tsc` |
| `npm run typecheck:backend` | Backend `tsc` |
| `npm run test` / `test:logic` | Vitest `110/110` |
| `npm run test:e2e` | Playwright `verify-all-fixes` `16/16` |
| `node tests/e2e/verify-fixes-api.mjs` | API `19/19` fresh (no cache) |
| `npm run check:all` | `typecheck` + `typecheck:backend` + `test:logic` |
| `cd backend && npm run db:migrate` | Apply migrations `0023`→`0033` |
| `cd backend && npm run db:studio` | Drizzle Studio |

## Environment

**Root `.env` (`.env.example`):**

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Backend URL (single `getApiBaseUrl()`) |
| `VITE_REPO_MODE` | `api` | `api` only |

**Backend `backend/.env.example`:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/erp` | PG |
| `REDIS_URL` | `redis://localhost:6379` | Required in `production` |
| `JWT_SECRET` | — | ≥32 chars |
| `CORS_ORIGIN` | `http://localhost:5173` | Refuses `*` in `production` |
| `APP_MASTER_KEY` | — | Base64 32 bytes |

## Architecture

```
Presentation (routes, middleware)  —  auth → RLS via withTenantTx
Infrastructure (repositories, drizzle, redis)
Application (use-cases, ports)     —  Zod via @erp/shared
Domain (entities via @erp/shared, money bigint, events)
```

`@erp/shared` is the single source for `is2dp`, `money`, Zod schemas, and entity helpers. No `className`/`markup` changes were made (design constraint).

## Verification

```bash
npm run typecheck && npm run typecheck:backend   # 0/0
npm run test:logic                               # 110/110
npx playwright test tests/e2e/verify-all-fixes.spec.ts --reporter=list  # 16/16
node tests/e2e/verify-fixes-api.mjs              # 19/19
```

Each `verify-all-fixes` test starts from `clearCookies`/`localStorage.clear()` — fresh view, no reliance on prior state.

## License

Private — all rights reserved.
