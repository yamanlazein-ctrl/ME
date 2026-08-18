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

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Dev server with hot reload               |
| `npm run build`      | Compile TypeScript to `dist/`            |
| `npm start`          | Run compiled server                      |
| `npm run db:generate`| Generate Drizzle migration SQL           |
| `npm run db:migrate` | Apply pending migrations                 |
| `npm run db:push`    | Push schema directly (dev only)          |
| `npm run db:studio`  | Drizzle Studio GUI                       |
| `npm run typecheck`  | `tsc --noEmit`                           |

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

| Variable                 | Required | Default     | Description                    |
| ------------------------ | -------- | ----------- | ------------------------------ |
| `NODE_ENV`               | No       | `development` | Runtime environment          |
| `PORT`                   | No       | `8080`      | Server port                    |
| `DATABASE_URL`           | Yes      | —           | PostgreSQL connection string   |
| `REDIS_URL`              | No       | —           | Redis connection string        |
| `JWT_SECRET`             | Yes      | —           | Min 32 chars                   |
| `JWT_EXPIRY_MS`          | No       | `1800000`   | Access token TTL (30 min)      |
| `REFRESH_TOKEN_EXPIRY_MS`| No       | `2592000000`| Refresh token TTL (30 days)    |
| `CORS_ORIGIN`            | No       | `*`         | Allowed CORS origins           |
| `RATE_LIMIT_RPS`         | No       | `100`       | Max requests per window        |
| `LOG_LEVEL`              | No       | `info`      | Pino log level                 |

## Docker

```bash
docker-compose up --build
```

Starts PostgreSQL, Redis and the API server.

## Tests

```bash
npm run typecheck
```

End-to-end suites live in the repo root under `tests/e2e/`.

## License

Private — all rights reserved.
