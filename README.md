# Motard Fabrics Group ERP

Arabic-language ERP for fabric & roll trading, built as a monorepo with a React
frontend, an Express + PostgreSQL API, a license-management admin dashboard, and
an optional Tauri desktop shell.

## Monorepo Layout

| Directory          | What it is                                                        |
| ------------------ | ----------------------------------------------------------------- |
| `src/`             | Web frontend — TanStack Start + React 19 (Arabic UI)              |
| `backend/`         | REST API — Express, Drizzle ORM, PostgreSQL 16+, Redis, Zod       |
| `admin-dashboard/` | License & activation admin panel — React + Vite                   |
| `desktop/`         | Tauri desktop wrapper around the web app (Rust)                   |
| `tests/e2e/`       | API + Playwright end-to-end suites                                 |
| `scripts/`         | Standalone verification / audit tooling                            |

## Features

- **Inventory** — fabrics, colors, rolls (kg-based), stock movements, warehouse & unit settings
- **Invoices** — sales, entries (purchases), partial payments, discounts, shipping, cancellation
- **Returns** — sale & entry returns with roll-level quantity conservation
- **Printing** — print jobs: send stock to print, receive finished rolls, track waste
- **Orders** — customer orders with stock reservation
- **Parties** — customers & suppliers with multi-currency balances
- **Ledger** — double-entry journal (every transaction balanced), statements, balance replay
- **Cashbox** — receipts, payments, expenses, transfer expenses, per-currency cashbox sessions
- **Dashboard & Reports** — KPIs, revenue / COGS / profit, alerts, global search
- **Settings** — company profile, currencies, taxes, payment methods, users, warehouses, printing
- **Auth & RBAC** — JWT (jose) + Argon2id, role-based access control, invitation codes
- **Licensing** — license generation & activation (admin dashboard), device registration
- **Multi-tenant** — tenant-scoped data with dedicated tenant tables
- **Reliability** — idempotency keys (Redis SET NX), concurrency-safe stock, rate limiting, audit log

## Tech Stack

### Web frontend (`src/`)

- React 19 + TypeScript
- TanStack Start / Router
- TanStack Query
- Tailwind CSS 4 + shadcn/ui-style components
- Zod + React Hook Form

### Backend (`backend/`)

- Node.js 22+ (LTS) — Express 4
- Drizzle ORM + PostgreSQL 16+
- Redis (ioredis) — idempotency keys, rate limiting
- Zod — runtime validation
- JWT (jose) + Argon2id — auth
- Pino — structured logging
- Sentry — optional error tracking

### Admin dashboard (`admin-dashboard/`)

- React 19 + Vite + React Router
- Tailwind CSS 4

### Desktop (`desktop/`)

- Tauri 2 (Rust shell) around the built web app
- **Windows Build** — see `desktop/BUILD-WINDOWS.md` for MSI/NSIS/EXE creation
- License binding, fingerprinting, 14-day trial, 3-device limit

## Quick Start (TL;DR)

```bash
# 1) Dependencies + infra
npm install
cd backend && npm install
cd backend && docker-compose up -d postgres redis   # or your local PG + Redis

# 2) Environment
cp .env.example .env            # root (frontend)
cd backend && cp .env.example .env && # edit DATABASE_URL, JWT_SECRET, REDIS_URL

# 3) Migrations → creates an EMPTY schema (fresh install)
cd backend && npm run db:migrate

# 4) Run
cd backend && npm run dev        # API on :8080
cd .. && npm run dev             # Web app on http://localhost:5173
```

> On a fresh database the tables/constraints are built by the migrations and it
> starts **empty**. Create the first user via the **initial setup wizard** when
> you open the app for the first time.

> Testing arsenal: `npm run test:logic` (Vitest), `npm run test:ui` (Playwright),
> `npm run check:all` — details in [`TESTING.md`](./TESTING.md).

## Getting Started

### 1. Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Redis 7+
- (Optional) Bun, for faster installs — `bun.lock` is provided

Or run the infrastructure with Docker Compose:

```bash
cd backend
docker-compose up -d postgres redis
```

### 2. Configure environment

Frontend (root):

```bash
cp .env.example .env
```

Backend:

```bash
cd backend
cp .env.example .env   # then edit DATABASE_URL, JWT_SECRET, REDIS_URL
```

### 3. Start the backend

```bash
cd backend
npm install
npm run db:push        # create tables (dev) — or use migrations
npm run dev            # http://localhost:8080
```

### 4. Start the frontend

```bash
cd ..
npm install
npm run dev            # Vite proxies /api -> http://localhost:8080 (edit vite.config.ts if needed)
```

Open the app in the browser. First-run setup wizard creates the admin tenant.

## Database Migrations

Migrations live in `backend/src/infrastructure/orm/migrations/`. Apply with:

```bash
cd backend
npm run db:migrate     # apply pending migrations
npm run db:generate    # generate a new migration after schema changes
npm run db:studio      # Drizzle Studio GUI
```

## Running Tests

| Command               | Scope                                              |
| --------------------- | -------------------------------------------------- |
| `npm run test`        | Frontend unit tests (Vitest)                       |
| `npm run test:api`    | Comprehensive API e2e (`tests/e2e/comprehensive-api.mjs`) |
| `npm run test:financial` | Financial double-entry lock-in e2e (`tests/e2e/financial-lock-in.mjs`) |
| `npm run test:e2e`    | Playwright comprehensive suite                     |
| `cd backend && npm run typecheck` | Backend typecheck                       |
| `npm run typecheck`   | Frontend typecheck                                 |

The e2e suites assume a running backend on port 8080 and a freshly reset
database (truncate all tables before running).

## Scripts (root)

| Script           | Description                                 |
| ---------------- | ------------------------------------------- |
| `npm run dev`    | Start Vite dev server                       |
| `npm run build`  | Production build                            |
| `npm run typecheck` | `tsc --noEmit`                         |
| `npm run test`   | Vitest unit tests                           |
| `npm run lint`   | ESLint                                      |
| `npm run format` | Prettier                                    |

## Environment Variables

Frontend (root `.env`) — see `.env.example`:

| Variable              | Default          | Description                |
| --------------------- | ---------------- | -------------------------- |
| `VITE_API_BASE_URL`   | `http://localhost:8080` | Backend API base URL |
| `VITE_API_TIMEOUT_MS` | `15000`          | API timeout                |
| `VITE_REPO_MODE`      | `api`            | Data access mode (`api` only) |

Backend (`backend/.env`) — see `backend/.env.example`:

| Variable             | Default     | Description                        |
| -------------------- | ----------- | ---------------------------------- |
| `NODE_ENV`           | `development` | Runtime environment               |
| `PORT`               | `8080`      | Server port                        |
| `DATABASE_URL`       | —           | PostgreSQL connection string       |
| `REDIS_URL`          | —           | Redis connection string            |
| `JWT_SECRET`         | —           | Min 32 chars                       |
| `JWT_EXPIRY_MS`      | `1800000`   | Access token TTL                   |
| `REFRESH_TOKEN_EXPIRY_MS` | `2592000000` | Refresh token TTL           |
| `CORS_ORIGIN`        | `*`         | Allowed CORS origins               |
| `RATE_LIMIT_RPS`     | `100`       | Max requests per window            |
| `LOG_LEVEL`          | `info`      | Pino log level                     |

## Architecture

The backend follows Clean Architecture with strictly inward-pointing dependencies:

```
Presentation (routes, middleware)
        │
Infrastructure (repositories, auth, DB, cache)
        │
Application (use cases, ports/DTOs)
        │
Domain (entities, value objects, errors, events)
```

The web frontend consumes the API through typed contracts
(`src/contracts/`) and presentation-layer hooks (`src/presentation/hooks/`).

## Docker

The backend provides a full `docker-compose.yml` (PostgreSQL + Redis + API):

```bash
cd backend
docker-compose up --build
```

## License

Private — all rights reserved.
