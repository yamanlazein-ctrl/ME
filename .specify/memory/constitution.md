<!--
Sync Impact Report
- Version change: 1.1.0 → 2.0.0 (MAJOR: the constitution's scope is redefined from the single
  "PostgreSQL → SQLite desktop" project to the whole Motard ERP product line, and Motard ERP Mobile
  becomes the active project. No desktop rule is weakened.)
- Title: "Motard Desktop (PostgreSQL → SQLite) Constitution" → "Motard ERP Constitution"
- Added principles (Core Principles, product-wide and mobile):
  I. Money Exactness · II. Append-Only Ledger & Atomic Documents · III. One Sync Protocol, Reused
  Unchanged · IV. Phone = Desktop = Hub Parity · V. Delivered Desktop Safety · VI. Offline-First,
  Same Roles · VII. Device Security · VIII. Phone-First Arabic UX · IX. Verifiable Quality ·
  X. Precision & Risk-First Delivery
- Moved: former principles I–X are kept unchanged in substance as D-I … D-X under the new section
  "Desktop Engine Principles (feature 001)". Former Scope, Workflow and Governance text for feature
  001 is folded into that section and into Governance.
- Added sections: "Desktop Engine Principles (feature 001)", "Mobile Scope & Technical Boundaries",
  "Development Workflow & Quality Gates" (rewritten for both tracks).
- Removed sections: none (content relocated, not dropped).
- Templates requiring updates: none — plan-template "Constitution Check" is generic and reads this
  file at runtime. ⚠ Plans for feature 001 that cite "Principles I–X" now mean D-I … D-X.
- Deferred TODOs: none. Owner decisions still open are listed in "Mobile Scope" and MUST be marked
  [NEEDS CLARIFICATION] by specs (not guessed).
- Sources: docs/PRD-mobile.md; Brain notes Money Rules, Accounting Rules, Ledger, Sync, Sync
  Operations Runbook, Idempotency, Auth and Roles, Multi-tenancy and RLS, Two Database Engines,
  Decisions, Open Issues; CLAUDE.md; verified in code: packages/shared/src/precision.ts
  (round2dp/round4dp, BigInt half-away-from-zero), backend/src/infrastructure/orm/sqlite/
  numericFunctions.ts (scaled integers, motard_* SQL functions),
  backend/src/infrastructure/repositories/sqlite/helpers/documentNumbers.ts (block sizes),
  backend/src/presentation/routes/sync.route.ts (revoke/reinstate, number-block claim),
  root package.json (eslint --max-warnings 0), tsconfig "strict": true (root, backend, shared).
-->

# Motard ERP Constitution

Motard ERP is one product line: a React web UI and an Express backend that run on two engines
(PostgreSQL on the sync hub, SQLite on devices), a delivered Windows desktop app, and — the active
project — **Motard ERP Mobile** (Android v1, React Native + Expo, TypeScript; scope in
`docs/PRD-mobile.md`). Principles I–X below govern every change in the repository. The desktop
engine principles D-I … D-X additionally govern the desktop and its SQLite engine.

## Core Principles

### I. Money Exactness (NON-NEGOTIABLE)

- Money arithmetic MUST round only through `round2dp` / `round4dp` from `@erp/shared`
  (`packages/shared/src/precision.ts`). `Math.round(x * 100) / 100` or any ad-hoc rounding of a
  product or quotient is prohibited.
- Rounding is exact decimal, half away from zero — identical to PostgreSQL `ROUND` and the SQLite
  engine's `roundDiv` (owner decision F-008).
- Storage: `numeric(14,2)` on PostgreSQL; scaled integers on SQLite (desktop and phone). `real`,
  `float4`, `float8`, or a binary-float `SUM()` for money or balances is prohibited.
- Division and decimal aggregation inside SQLite queries MUST keep PostgreSQL results exactly
  (today via `motard_pgdiv`, `motard_dectext`, `motard_decsum`). A replacement on the phone MUST
  prove identical output on the same inputs before it is used.
- Totals are computed by the use-case (server-side logic), never by the UI. The UI only displays.
- `exchangeRate` = SYP per 1 USD (USD→SYP multiply, SYP→USD divide). USD and SYP balances MUST
  NEVER be summed, netted or shown as one figure.
- Invoice, line, discount, tax and shipping formulas are the ones in Brain "Accounting Rules"
  (fixed-amount discounts; `defaultDiscount`, party `vat` and settings `taxes[].rate` are display
  only). Changing any of them is an owner accounting decision, not an engineering choice.

Rationale: money stored as `real` once drifted above 16,777,216 SYP and trial balances never
balanced; the hub recomputes synced documents, so every device must round identically.

### II. Append-Only Ledger & Atomic Documents (NON-NEGOTIABLE)

- The ledger is append-only on every engine (DB triggers). A cancel writes reversal entries; it
  never edits or deletes. The only sanctioned remap is the party-merge `party_id` move, which is not
  in mobile scope.
- The FX rate is frozen on each invoice, voucher, return and ledger entry at write time.
- Saving a document is ONE local transaction: numbering + header + lines + ledger entries + linked
  voucher + cashbox (+ stock movement), committed before success is shown. A crash leaves the
  document fully present or fully absent.
- Entities a document needs (for example new colours and rolls on an entry invoice) MUST be created
  inside that same use-case transaction — never client-side before posting (the desktop's orphan
  risk MUST NOT be copied).
- Voucher amendment uses `replace` (cancel + create in one transaction), never two operations.
- COGS is the `cost_per_kg` snapshot at sale; returns use the unweighted average roll price at the
  invoice's frozen rate; a roll price is editable only before its first sale.
- Locked days and closed years refuse writes with the existing messages.

### III. One Sync Protocol, Reused Unchanged (NON-NEGOTIABLE)

- A phone is a sync device exactly like a desktop. It MUST reuse the existing protocol and its
  code, not a new one:
  - `sync_outbox` → hub `sync_inbox`, deduped on `(tenant_id, op_id)` with a durable `op_id`
  - pull cursor `sync_inbox.applied_seq`
  - push lanes (lane 0 for masters, orders, ledger, settlements, cashbox, settings, company — in
    recorded order; lanes 1–3 hashed by document)
  - `document_number_blocks` with `knownUsed` reporting, plus fallback numbering
  - resource claims: first write to reach the hub wins; the loser's document is cancelled locally
    and the user is told; a `dead` unit (5 failed materializations) needs a human, and there is no
    requeue button
  - hub epoch change → rebase (reset cursor, re-queue delivered history, re-report tips)
  - a restored or re-installed device gets a new sync identity
- Every financial write carries idempotency: an `Idempotency-Key` on HTTP financial POSTs (428
  without it) and a durable `op_id` on sync units. Re-sending MUST NOT duplicate.
- Units are enqueued only through the existing use-case enqueue path (`syncEnqueue`), never by
  writing outbox rows from UI or repository code.
- The hub API contract MUST NOT change, except the backend changes listed in PRD §11.3 (BC-1 phone
  block sizes, BC-2 version gate, BC-3 revoked reason code, BC-4 desktop QR, BC-5 version
  manifest, BC-6 core extraction). Any other contract change requires a constitution amendment.
- Known gap, not to be "fixed" silently in mobile work: hub web-UI writes are not in the pull
  stream.

### IV. Phone = Desktop = Hub Parity (NON-NEGOTIABLE)

- For the same inputs, phone, desktop and hub MUST produce identical totals, balances, statements,
  ledger entries, cashbox and stock movements, document numbers and FX results.
- Two parity gates are mandatory and block merge and release:
  1. **Money vectors** — a shared, versioned set of money/rounding cases run on Node (desktop and
     hub) and on the phone's JavaScript engine (Hermes), with zero differences. It does not exist
     yet as a cross-runtime suite; it MUST be created before any mobile money code is merged
     (seeded from the existing `precision.test.ts` and `money-precision.test.ts` cases).
  2. **Sync parity suite** — documents created on a phone, synced through a disposable test hub
     and pulled by a desktop, compared field by field across all three, including claim loss,
     fallback numbering and epoch rebase.
- Statement order `date, created_at, document-rank, id` and its cursor predicates MUST stay
  identical on every engine.
- Parity is proven by executed tests. Code reading is not proof.

### V. Delivered Desktop Safety (NON-NEGOTIABLE)

- The delivered Windows app MUST never break. Any change to shared code (`packages/shared`,
  `backend/`, a future `packages/core`) MUST keep the full desktop SQLite suite and the PostgreSQL
  suite green before merge, run one at a time on this machine.
- A repository change goes into the `Postgres*` file and its `Sqlite*` twin. A schema change needs a
  migration for each engine with journals in sync, and `npm run typecheck:sqlite` passing. The phone
  uses the same SQLite schema, migrations and fingerprint. It MUST NOT fork them.
- Mobile code MUST NOT import Node-only modules (`fs`, `net`, `child_process`, `pg`, Express, `node:*`)
  directly or transitively. This is enforced by a lint import boundary, following the existing
  backend `pg` boundary (D-006).
- Mobile work MUST NOT change desktop behavior, desktop screens, or desktop data under
  `%LOCALAPPDATA%\MotardERP`. Tests use temp databases or `erp_test` / `erp_cert*` only.
- No commit, push or deploy unless the owner asks. Another agent may share the working tree: never
  `git stash` or reset it.

### VI. Offline-First, Same Roles

- Every Must write flow in `docs/PRD-mobile.md` MUST work in airplane mode with no time limit.
  Network is needed only for enrollment, bootstrap and sync.
- The phone holds the full tenant data, like the desktop (owner decision); one tenant per device,
  fixed at enrollment.
- Roles and offline rights equal the desktop's: `admin` and `accountant` write offline; `warehouse`
  and `viewer` are read-only offline. The accountant holds every admin privilege
  (`hasAdminPrivileges`). Strict `admin` checks are only for granting the admin role, editing an
  admin account, and revoking devices. Nobody changes their own role.
- Session is permanent, as on the desktop (owner decision 2026-09-26): it ends only on logout, a
  refused refresh (401/403 on refresh), revocation or a wipe. A 403 elsewhere is not a session
  end. The biometric/PIN app lock is separate from the session.
- Sync state (synced / pending N / offline / attention) is visible on every screen. Local work never
  waits on the network.

### VII. Device Security

- The phone database is encrypted at rest (SQLCipher). Its key, tokens and the device credential
  live only in the Android Keystore (secure storage).
- Passwords and PIN verifiers use Argon2id with the desktop's parameters (decision D-005). JWT stays
  HS256 with `jti`.
- Remote revoke + wipe: an admin revokes the phone (`POST /sync/devices/:deviceId/revoke`). When the
  phone learns it is revoked, it deletes its database, keys and cached files and returns to
  enrollment.
- No secret, DSN, token or key in the APK, the repository, logs or chat. The hub URL comes from
  enrollment.
- No telemetry or crash SDK in v1 (the desktop build ships with Sentry off).
- The direct APK and the Google Play build MUST share one owner-held app signing key.

### VIII. Phone-First Arabic UX

- Designed for phones from scratch. A desktop screen MUST NOT be shrunk or copied. One task per
  screen; multi-step flows (party → lines → review) replace giant screens; tables become cards; no
  horizontal page scroll from 360 dp to 480 dp.
- Arabic only, full RTL, with mirrored directional icons. Arabic copy is reused from the desktop
  where it is correct.
- Touch targets ≥ 48 dp; body text ≥ 16 sp; WCAG AA contrast; layout holds at 130% system font
  scale. The primary action sits at the bottom within thumb reach and stays visible above the
  keyboard.
- Every amount shows its currency. A negative balance shows both a sign and a colour.
- Same brand identity as the desktop (logo, colours, font tokens from `src/styles.css`), but with
  more spacing and fewer elements per screen.
- Feedback follows the desktop rules: success uses a success toast, never an error toast. Every
  form field is tied to its label.
- Known desktop mistakes MUST NOT be copied. Examples: client-side entity creation before posting,
  multi-purpose giant screens, and the settings sprawl.

### IX. Verifiable Quality

- TypeScript `strict: true` in all mobile and shared code. No `any` without a written reason, and no
  `eslint-disable` comments — fix the cause (the repository rule).
- Lint passes with 0 errors and 0 warnings (`--max-warnings 0`), and Prettier passes, as in CI.
- Every task in `tasks.md` names its automated check: a unit, integration, parity or device-e2e test,
  or a CI gate that fails if the task is undone. A task without a check is incomplete.
- `vitest --reporter=basic` is prohibited as evidence (it can exit 0 having run nothing); read the
  summary line.
- Claims that something works, is fixed or is unchanged MUST be backed by an executed test or
  reproducible evidence. Unknowns stay labelled UNKNOWN until proven.

### X. Precision & Risk-First Delivery

- Specs, plans and tasks MUST be precise enough for a cold cloud agent to implement with zero
  guessing: exact file paths, function or use-case names, endpoint paths, field names, values and
  the acceptance check.
- "TBD", "etc.", "as needed", "appropriate", "robust" or any similar vague wording is prohibited in
  every artifact. An unknown owner decision is written as `[NEEDS CLARIFICATION: question —
recommended answer]` and MUST be resolved before `/speckit-tasks`. `tasks.md` contains none.
- The highest-risk work goes first. The M0 spikes (S1 SQLite driver with SQLCipher, synchronous
  calls, user-defined functions and safe integers; S2 use-cases compiled for Hermes/Metro; S3 PDF
  from the desktop print HTML with an Arabic font) MUST pass on a real mid-range Android, or their
  fallback must be chosen, before M1 work starts.
- Facts are taken from the project brain and verified in code with targeted lookups. Nothing is
  invented. Owner decisions are never made by an implementer.

## Desktop Engine Principles (feature 001)

These carry principles I–X of constitution v1.1.0 (feature `specs/001-desktop-sqlite-engine`,
source `docs/PRD-DESKTOP-SQLITE.md`). They are unchanged in substance and govern any change to the
desktop app or its SQLite engine. Their PRD tags are cited in that PRD.

- **D-I Desktop Engine Boundary.** SQLite is the only desktop database. No PostgreSQL binary,
  process, data directory or local database TCP port; frontend ↔ backend stays on the named pipe /
  IPC; the supervisor manages only the Node backend's lifecycle. The PostgreSQL code path stays
  behaviorally identical. The only approved cloud changes were D-3, D-4 and Track P (FR-070).
- **D-II Behavioral & Accounting Parity.** The PostgreSQL build is the reference oracle. Every
  PostgreSQL mechanism (triggers, RLS, `FOR UPDATE`, `ON CONFLICT`, `RETURNING`, sequences,
  trigram search) is reproduced on SQLite with a parity test.
- **D-III Complete Schema, Relationships & History.** No table, column, constraint, foreign key or
  index is dropped. The schema source of truth is Drizzle plus the raw-SQL migrations. Referential
  integrity is enforced on every connection. `cancelled` semantics hold in every list.
- **D-IV Atomic & Durable Financial Writes.** One transaction per multi-record operation. Success is
  reported only once the write is durable. No `synchronous=OFF` or `journal_mode=OFF/MEMORY`. No
  double allocation of stock or numbers.
- **D-V No Artificial Limits.** No `LIMIT`, cap or silent truncation hides data. Performance comes
  from indexes and keyset paging. Statements show full history.
- **D-VI Data Identity & Safe Lifecycle.** Never auto-delete, replace or silently create a
  database. The data root is `%LOCALAPPDATA%\MotardERP`. Uninstall keeps data. Update = save →
  safe close → apply → relaunch on the same database.
- **D-VII Verified Backup & Restore.** A backup is VERIFIED only after its integrity checks pass.
  Restore is backup current → copy → migrate → verify → open, and the original is never modified.
- **D-VIII Offline-First Sync Fidelity.** Sync meaning, scope and wire format are unchanged. Devices
  converge with no silent overwrite. Restore on a synced device pauses sync and reconciles first.
- **D-IX Preserve Domain Logic.** Change only what the engine forces. No opportunistic refactors.
- **D-X Packaged EXE Is the Release Truth.** Gates run on the final packaged EXE through the
  lifecycle protocol. Any data-loss, accounting, wrong-database, backup, sync or PostgreSQL-port
  failure blocks release.

## Mobile Scope & Technical Boundaries

- **Source of truth:** `docs/PRD-mobile.md`. If a spec and the PRD conflict, work stops until the
  owner amends one of them.
- **In scope (v1):** the Android app in `mobile/` (branch `feat/mobile`), the Must/Should items of
  PRD §5, and backend changes BC-1 … BC-6 only.
- **Out of scope (v1):**
  - iOS release (the code stays iOS-compatible)
  - barcode scanning of rolls
  - server push notifications
  - LAN / direct desktop sync
  - WhatsApp Business API
  - English UI
  - system settings, year closing, the ledger screen, the print center / press invoices, the
    sync-conflict resolution screen and the activity log on the phone
  - backup/restore, merge, Phenix import, licence admin, party merge, dye purge
- **Stack:**
  - React Native + Expo dev build (not Expo Go), TypeScript, Expo Router, React Query
  - Drizzle on encrypted SQLite
  - `@erp/shared` imported, never copied
- **Open decisions (MUST be marked `[NEEDS CLARIFICATION]`, not guessed):**
  - Q1: `packages/core` extraction vs alias import + lint boundary
  - Q2: offline stock-count roles
  - Q3: phone block sizes
  - Q4: whether the hub already enforces a version gate
  - Q5: dark theme in v1
  - plus the owner accounting decisions in Brain "Open Issues": M-02 per-currency day close, return
    header discounts, S-02 rounding, return valuation, and the others listed there
- **Same-version rule:** the hub and every desktop and phone MUST run the same money/rounding
  version. A phone with a mismatched version MUST NOT sync.

## Development Workflow & Quality Gates

- **Sequence (mobile):**
  - M0: the spikes
  - M1: core, DB, enrollment, bootstrap, sync loop, parity suites
  - M2: read flows
  - M3: write flows
  - M4: sharing and security
  - M5: a 30-day pilot with at least 5 phones

  No milestone starts before the previous one's exit criteria in PRD §17.1 pass.

- **Merge gates** (all required):
  - typecheck (strict)
  - lint with 0 warnings
  - Prettier
  - mobile unit tests
  - the money-vector suite on Node and Hermes
  - the sync parity suite
  - the desktop SQLite and PostgreSQL suites, when shared code changed
  - `npm run typecheck:sqlite`, when schema changed
- **Release gates (mobile):**
  - the signed APK under test is byte-identical to the shipped APK
  - airplane-mode device e2e for all Must write flows
  - revoke + wipe proven
  - version gate proven
  - NFR performance targets met on the reference mid-range Android at 100k documents
- **Constitution Check:** every `/speckit-plan` maps its design to Principles I–X (and D-I … D-X when
  the desktop is touched). Each deviation is listed in Complexity Tracking with a justification and
  the owner's sign-off.
- **Review rejects:**
  - non-centralized rounding (I)
  - ledger edits, or a multi-record write that isn't atomic (II)
  - a new sync path or an unlisted contract change (III)
  - an untested parity claim (IV)
  - Node imports in mobile code, or a desktop suite left red (V)
  - a network-required Must write flow (VI)
  - secrets or telemetry (VII)
  - a shrunk desktop screen or an amount without its currency (VIII)
  - a task without a check (IX)
  - vague wording (X)

## Governance

- This constitution supersedes conflicting practice for every spec, plan, task list and review in
  the repository. It is derived from `docs/PRD-mobile.md`, `docs/PRD-DESKTOP-SQLITE.md`, the project
  brain and `CLAUDE.md`. If the sources conflict, work stops until the owner decides. Implementers
  MUST NOT choose between them.
- **Amendments:** an amendment requires a written change, the owner's approval, a semantic version
  bump and an updated Sync Impact Report. The version bump follows these rules:
  - MAJOR: a principle is removed or redefined, or the scope changes.
  - MINOR: a principle or section is added or materially expanded.
  - PATCH: clarifications only.
- **Non-waivable:** Principles I, II, III, IV, V and VII, and D-II, D-III, D-IV, D-VI, D-VII and D-X.
  Other deviations need a documented justification and the owner's sign-off in Complexity Tracking.
- **Compliance:** `/speckit-analyze` and every review check artifacts against this file. Release
  readiness is defined by the release gates above (mobile) and by D-X (desktop).

**Version**: 2.0.0 | **Ratified**: 2026-10-03 | **Last Amended**: 2026-10-25
