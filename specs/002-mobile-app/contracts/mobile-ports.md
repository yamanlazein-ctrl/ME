# Contract: Phone adapters for desktop code (import boundary)

The phone bundles code from `backend/src` and `packages/shared/src` in place (research R1). Each
Node or desktop dependency that code reaches is replaced, at bundle time, by exactly one phone
adapter. Anything not listed here fails the Metro build (`mobile/metro.config.js` resolver) and the
lint rule (`mobile/eslint.config.js`).

## Allowed replacements (Metro `resolveRequest` mapping)

- `node:async_hooks` → `mobile/src/platform/asyncContext.ts`.
  - Exports `AsyncLocalStorage` with `run(store, fn)`, `getStore()` and `enterWith(store)`.
  - Correct only because every use-case runs through `mobile/src/core/serialExecutor.ts`
    (research R3).
- `node:crypto` → `mobile/src/platform/nodeCrypto.ts`.
  - Exports only `randomUUID`, `createHash` (sha256 only: `update` / `digest('hex' | 'base64')`),
    `randomBytes` and `timingSafeEqual` (research R4).
- `better-sqlite3` → `mobile/src/platform/sqlite/BetterSqliteShim.ts` (spike S1, research R2).
  - Must provide the members used by:
    - `backend/src/infrastructure/orm/sqlite/connection.ts`
    - `transaction.ts`
    - `sequences.ts`
    - `queryable.ts`
    - `exactIntegers.ts`
    - `numericFunctions.ts`
  - Those members are `prepare(sql)` returning `run/get/all/iterate/raw/safeIntegers`, `pragma`,
    `exec`, `function`, `aggregate`, `transaction`, `close`.
- `backend/src/infrastructure/config/logger.ts` (resolved file path) → `mobile/src/platform/logger.ts`.
  - Same named exports as the real file; console only (NFR-12). 18 shared files import this file or
    `config/env.ts` (checked 2026-10-25), and the real files use `node:path`, `node:url`, `pino` and
    `dotenv`, so they are replaced, not bundled.
- `backend/src/infrastructure/config/env.ts` (resolved file path) → `mobile/src/platform/envConfig.ts`.
  - Exports `config` with every field the bundled files read (listed by tasks T045), holding phone
    values. No `process.env` reads.
- `drizzle-orm/better-sqlite3` → resolved normally. Drizzle receives the shim object, and the same
  drizzle-orm version as `backend/package.json` (0.45.2) is pinned in `mobile/package.json`.

## Banned on the phone (lint and Metro both fail)

- `node:fs`, `node:path`, `node:os`, `node:net`, `node:url`
- `fs`, `path`, `os`, `net`, `child_process`, `http`, `https`
- `express`, `pg`, `argon2`, `googleapis`, `pino`, `@sentry/*`

Desktop-only files that use them stay out of the phone bundle because the phone composition root
never imports them. The files found on 2026-10-25 that must stay out:

- `backend/src/infrastructure/orm/runDesktopMigrations.ts`
- `backend/src/infrastructure/orm/sqlite/runtime.ts` (uses fs and path; replaced by
  `mobile/src/core/runtime.ts`, which opens the shim and runs the same migration SQL files bundled
  as assets)
- `backend/src/infrastructure/repositories/sqlite/SqliteDesktopActivationStore.ts`
- `backend/src/infrastructure/di/sqliteContainer.ts` (replaced by `mobile/src/core/container.ts`)
- the setup, invitation and super-admin use-cases

The phone also needs these, adapted or wrapped:

- `syncRestoreUseCases.ts`: needed by the epoch rebase path. If it reaches fs, the rebase helper it
  needs is wrapped in `mobile/src/core/` (fallback F2).
- `hubIdentity.ts`, `hubConfig.ts`, `numberBlockUseCases.ts`, `syncEnqueue.ts`,
  `syncEnrollment.ts`, `syncUseCases.ts`: they import `node:crypto` only, which is mapped above.
- `SqliteInvoiceRepository.ts`, `SqliteStatementRepository.ts`: they import `node:crypto` only.
- `orm/sqlite/clock.ts`, `transaction.ts`, `ambient-tx.ts`, `tenant-context.ts`: they import
  `node:async_hooks`, which is mapped above.
- `orm/sqlite/schemaFingerprint.ts`, `orm/sqlite/types.ts`, `orm/schemaFingerprint.ts`: the
  Node-only part each uses is read in M0 task S2. If it is `node:crypto`, it is mapped. If it is
  fs, the phone uses a fingerprint value precomputed at build time (`mobile/scripts/`).

## Ports the phone implements (from the desktop container)

`mobile/src/core/container.ts` provides the same port objects that
`backend/src/infrastructure/di/sqliteContainer.ts` provides, for the repositories and use-cases in
scope. It provides phone implementations for:

- **secret store:** `ISecretsRepository` / `ISecretCipher` → `expo-secure-store`.
- **logger:** a console logger with the `pino`-shaped `info/warn/error` used by the shared code. No
  remote sink (NFR-12).
- **config:** a frozen object built from the enrollment data. No `process.env` reads at runtime.
- **fetch:** the platform `fetch`, which React Native provides.
