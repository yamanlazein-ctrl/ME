# ERP Backend

Express REST API for the Motard Fabrics ERP — clean architecture, double-entry
ledger, multi-tenant, license-gated.

## Tech Stack

- **Runtime**: Node.js 22+ (LTS)
- **Framework**: Express.js
- **ORM**: Drizzle ORM + PostgreSQL 16+
- **Validation**: Zod
- **Auth**: JWT (jose) + Argon2id
- **Cache/Queue**: Redis (ioredis) — idempotency keys, rate limiting
- **Logging**: Pino (+ optional Sentry)

## Architecture

```
Presentation (routes, middleware)
        |
Infrastructure (repositories, auth, DB, cache)
        |
Application (use cases, ports/DTOs)
        |
Domain (entities, value objects, errors, events)
```

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Redis 7+

Or use Docker Compose:

```bash
docker-compose up -d postgres redis
```

### Environment

```bash
cp .env.example .env
# Edit .env with your database and Redis URLs
```

### Install & run

```bash
npm install
npm run db:push       # create tables from schema (dev)
# or
npm run db:migrate    # apply committed migrations
npm run dev           # dev server with hot reload (tsx watch)
```

The API will be available at `http://localhost:8080`.

## Scripts

| Command               | Description                     |
| --------------------- | ------------------------------- |
| `npm run dev`         | Dev server with hot reload      |
| `npm run build`       | Compile TypeScript to `dist/`   |
| `npm start`           | Run compiled server             |
| `npm run db:generate` | Generate Drizzle migration SQL  |
| `npm run db:migrate`  | Apply pending migrations        |
| `npm run db:push`     | Push schema directly (dev only) |
| `npm run db:studio`   | Drizzle Studio GUI              |
| `npm run typecheck`   | `tsc --noEmit`                  |

## API Overview

### Auth

- `POST /api/auth/login` — email/password login
- `POST /api/auth/refresh` — refresh access token
- `POST /api/auth/logout` — logout (invalidate token)

### Health

- `GET /api/health/live` — liveness probe
- `GET /api/health/ready` — readiness probe (DB + Redis)
- `GET /api/health/deep` — deep health (admin only)

### Business modules

Invoices, returns, printing (send/receive), orders, parties, rolls/fabrics/colors,
cashbox, receipts/payments/expenses, ledger & statements, dashboard & reports,
settings, setup wizard, license, notifications, invitations.

## Folder Structure

```
src/
  domain/            # Entities, value objects, errors, events, types
  application/       # Use cases, repository ports, DTOs, services
  infrastructure/    # Repositories, ORM, auth, middleware, DI, config
  presentation/      # HTTP routes, server entry point
  scripts/           # Seed & admin helpers
```

## Environment Variables

| Variable                  | Required | Default       | Description                  |
| ------------------------- | -------- | ------------- | ---------------------------- |
| `NODE_ENV`                | No       | `development` | Runtime environment          |
| `HOST`                    | No       | `0.0.0.0`     | Bind address for the API     |
| `PORT`                    | No       | `8080`        | Server port                  |
| `DATABASE_URL`            | Yes      | —             | PostgreSQL connection string |
| `REDIS_URL`               | No       | —             | Redis connection string      |
| `JWT_SECRET`              | Yes      | —             | Min 32 chars                 |
| `JWT_EXPIRY_MS`           | No       | `1800000`     | Access token TTL (30 min)    |
| `REFRESH_TOKEN_EXPIRY_MS` | No       | `31536000000` | Refresh token TTL (365 days) |
| `CORS_ORIGIN`             | No       | local allowlist | Allowed CORS origins       |
| `RATE_LIMIT_RPS`          | No       | `100`         | Max requests per window      |
| `LOG_LEVEL`               | No       | `info`        | Pino log level               |

## Docker

```bash
docker-compose up --build
```

Starts PostgreSQL, Redis and the API server.

### Production central-server stack

For a shared central ERP server, use the production compose file:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

This stack provides:

- PostgreSQL 16 with a persistent volume
- Redis 7 for the token denylist
- The backend in `NODE_ENV=production`
- Nginx reverse proxy with HTTPS termination

Place your TLS certificate files at:

```text
backend/deploy/certs/fullchain.pem
backend/deploy/certs/privkey.pem
```

And update `CORS_ORIGIN` in `.env.production` to the real public origins that
will call the API directly.

## Tests

```bash
npm run typecheck
```

End-to-end suites live in the repo root under `tests/e2e/`.

## License

Private — all rights reserved.
