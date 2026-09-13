# SYNC MASTER REPAIR PLAN

> **Status:** PLAN ONLY — authoritative source of truth for Sync repair/completion.
> **Derived from:** current working-tree code (HEAD `3498c7e`, tree unchanged at plan time).
> Historical docs (`SYNC-AUDIT-2026-09-10.md`, `SYNC-FIX-RESULTS-2026-09-10.md`,
> `OFFLINE-SYNC-GAP-ANALYSIS.md`) are records, not authority. Previous PASS/FIXED
> claims were not inherited — every statement below was re-derived by reading code.
> No code, test, migration, or config was modified to produce this plan.

## 1. Scope and Long-Term Goal

Complete the EXISTING Sync system to production-grade quality and close all genuine
Sync gaps — one ordered roadmap, no alternative plans. This covers Sync only, not the
whole ERP. The system must stay reliable and maintainable for 10+ years, optimizing for
root-cause correctness, data/accounting/inventory integrity, atomicity, idempotency,
deterministic sync, recovery, backward compatibility, upgrade safety, observability,
security, maintainability, and scalability — never for green harnesses, cosmetic fixes,
suppressed errors, hardcoding, weakened invariants, or test edits that hide defects.
The existing architecture is preserved where correct (it is, in its foundation);
architectural change is recommended only where the current design is proven incapable,
with code evidence in each case (only SYNC-04 partly qualifies, and it keeps FWW).

## 2. Current Sync Architecture

Reconstructed from working-tree source (file sizes: `syncUseCases.ts` 901,
`syncMaterialize.ts` 595, `syncDependencySnapshots.ts` 542, `syncEnqueue.ts` 336,
`numberBlockUseCases.ts` 280, `sync.route.ts` 423 lines).

```
DEVICE (browser/desktop — NO client-side outbox; all mutations are online API calls)
→ route opens ONE withTenantTx (ambient-tx proxy rebinds every repo call onto it)
→ business use-case + outbox.enqueue commit/rollback atomically (F-07 transactional outbox)
→ sync_outbox (pending; seq bigserial; uq tenant+opId)
→ runLocalSyncPush: listClaimable(50, seq order, 5-min pushing-lease reclaim)
→ markPushing → per-unit POST /sync/push (15 s timeout)
→ HUB inbox.receive (uq tenant+opId: rejected→re-409, applied→200 dedupe)
→ claims.tryClaimAll (ONE db tx, savepoint-guarded inserts, idempotent per opId)
→ conflict? markRejected + notify loser (kind='sync') → 409 SYNC_CONFLICT
→ materializeSyncUnit → domain use-case replay (preAllocatedId/Number, replayCtx, ensureDeps)
→ created/exists→markApplied (+cancel-claim release) | invalid→dead | retryable→received+attempts (5→dead)
→ pull GET /sync/pull?afterSeq=&excludeSyncDeviceId=&limit= (applied only, received_seq order)
→ local inbox mirror → local materialize (same quad-state) → advance sync_state.lastPullSeq
```

Stage-by-stage accountability:

| Stage | File → Function | Table | Tx boundary | Failure / retry / idempotency / ordering |
|---|---|---|---|---|
| Enqueue enable | `sync/syncEnqueue.ts:12-14` | — | — | enabled iff `DESKTOP_DEPLOY \|\| CENTRAL_SYNC_URL` |
| Op/device identity | `syncEnqueue.ts:16-34` | — | — | device from `tenantContext.syncDeviceId` else `x-sync-device-id` (UUID-validated); opId from `Idempotency-Key` else `randomUUID` |
| Typed enqueues | `syncEnqueue.ts:40-336`, `syncUseCases.ts:28-72` | `sync_outbox` | ambient route tx | payload always carries `actorUserId/actorRole/actorUserName` + `preAllocated:true` + `dependencies`; dedupe by `(tenant,opId)` in `PostgresSyncOutboxRepository.enqueue:42-66` |
| Atomicity | `orm/ambient-tx.ts`, `orm/drizzle.ts:116-132` | — | ONE `withTenantTx` per route; inner `db.transaction` becomes savepoint | failure → `SYNC_OUTBOX_FAILED` hard error, never false 201 (statically pinned, `sync-invariants.test.ts:326-386`) |
| Outbox | `schemas/sync-outbox.table.ts` (55) | `sync_outbox` | — | `seq bigserial` only stable order key; statuses pending/pushing/synced/rejected |
| Push | `syncUseCases.ts:101-231` | `sync_outbox` | per-unit POSTs, no batch tx | 409→`markRejected`+rollback; retryable (5xx,401,403,408,425,429)→`resetToPending`; else rejected; throw→pending |
| Hub receive | `syncUseCases.ts:472-511` | `sync_inbox` | single-statement receive | idempotent `(tenant,opId)`; accepted-not-applied→retry materialize |
| Claims | `PostgresSyncResourceClaimRepository.tryClaimAll:29-154` | `sync_resource_claims` | ONE db tx; inserts in nested savepoint | dedupe in-unit; same-opId→ok; unique `(tenant,resourceType,resourceId)`; conflicts re-read |
| Conflict | `syncUseCases.ts:513-586` | `sync_inbox` | — | loser `markRejected` + notification; namespaces in `extractConflictResources:766-844`; masters claim nothing (Strategy B, deliberate) |
| Materialize | `syncMaterialize.ts:118-170` | business tables | per-use-case tx | 13 pairs (invoice c/u/x, voucher c, return c/x, order c/x, expense c/x, 4×master c); else `invalid`; creates→`findById(preAllocatedId)`→`exists`; cancels of cancelled→`exists`; missing payload→`invalid`; missing target→`failed` (retryable, correct) |
| Dependencies | `syncDependencySnapshots.ts:409-528` | masters + stock | `runWithTenantContext` ONLY — **no `db.transaction`** (verified `:414`) | insert-if-missing per table; party failure rethrows→retryable; stock rewind by direction |
| Pull | `syncUseCases.ts:234-435` | `sync_inbox`→`sync_state` | per-unit + cursor upsert | `afterSeq+exclude+limit50`; hub `listAppliedSince` in-SQL device exclusion, `receivedSeq>afterSeq`, clamp 1–100; mirror→materialize; `invalid`→dead; retryable holds cursor (`break`) until 5→dead; cursor persisted only if `items>0 && maxSeq!==afterSeq` |
| Cursor | `schemas/sync-state.table.ts` (22), migration `0053` | `sync_state` | upsert on `(tenantId)` | `lastPullSeq bigint` real cursor; `lastPullAt` display-only; `seq`/`received_seq` bigserial added because `created_at`/`received_at` are txn-start time |
| Number blocks | `numberBlockUseCases.ts`, `utils/documentNumbers.ts`, migration `0049` | `document_number_blocks` | `db.transaction` per claim/reclaim | auto-provisioned: invoice, invoice_entry, customer, supplier; voucher/return/expense/order have sizes but NOT auto-ensured → shared-sequence fallback + warn (`documentNumbers.ts:170-183`); hub-claim-first + local fallback; first-use race fixed by single upsert-increment |
| Trigger | `src/lib/sync-engine.ts:21-45`, `hooks/useAutoSync.ts`, `hooks/useConnectivity.ts`, `lib/sync-device.ts` | — | — | thin server-delegated trigger; module `running` flag **silently drops overlaps** (null); fire-once per offline→online; warn-only, no backoff; device id in `localStorage erp.sync.deviceId`; registration `POST /api/auth/sync-device` keyed `(tenant,fingerprint)` |
| Auth/tenancy | `http/middleware/auth.middleware.ts:35-74`, `orm/rls/enable-rls.sql:48-79` | all 6 sync tables | `SET LOCAL` per tx | JWT+denylist; tenant from JWT only; device header opportunistic non-credential; RLS FORCE + `NULLIF` PG17 guard; `TenantScopedPool` stamps GUCs per checkout |
| Offline policy | `domain/sync/offlineWritePolicy.ts:8-10`, `offline-write.middleware.ts:10-28` | — | — | **admin + accountant may write offline; warehouse + viewer 403** (`canWriteOffline` re-verified at plan time); frontend sets flag + `X-Offline-Mode` header only |

Deliberate non-atomicity (do NOT "fix" by merging): hub claim-tx, materialize-tx, and
inbox-status writes are separate transactions. Claim-without-apply on crash is
compensated by retry + dead-letter. Merging them would couple contention domains.

## 3. Current Offline-First Architecture

Product requirement: a device works without Internet for promised operations; on
reconnect, LOCAL DATA → DURABLE OUTBOX → HUB → CONFLICT/VALIDATION → APPLY → PEERS →
CONVERGENCE. Current reality, verified:

- **Local persistence:** local/desktop PostgreSQL holds business tables AND sync tables
  (`sync_outbox/inbox/state/claims/devices`, `document_number_blocks`). Real local
  transactions via `withTenantTx`. Business+outbox atomic where enqueue exists.
- **Durable local outbox:** yes where wired — PG-backed, survives process restart,
  SIGKILL (F-07 script §6 asserts pending-before == pending-after), PG restart, machine
  reboot (all state durable, no in-memory watermarks). `pushing` lease (5 min) reclaims
  crashed-run units.
- **Offline writes:** permitted per role matrix (admin/accountant); warehouse/viewer
  read-only offline. No browser IndexedDB — desktop+local-backend assumed (admitted in
  audit §3). Frontend performs no queued writes; "offline" means the local backend is
  reachable while the hub is not.
- **Offline references:** an offline-created entity CAN be referenced by a later offline
  op (pre-allocated UUIDs; dependency snapshots for invoice/return carry masters; hub
  replays deps-first). Gap: voucher/order/expense carry no snapshots (SYNC-02).
- **Offline numbering:** reserved blocks for 4/8 types; the other 4 fall back to shared
  sequence with warning (SYNC-05). Block exhaustion surfaces via `missingBlocks`.
- **Reconnect:** `POST /sync/run` = push (seq order) then pull (cursor), plus block
  ensure; auto-fires once per offline→online transition. Long-offline (hours/days)
  works through the same cursor; batches of 50.
- **Update/restore hazards:** device identity in localStorage (reinstall orphans
  blocks/cursors); sync tables must be preserved across backup/restore/update or
  explicitly drained — no drill exists (SYNC-11).

## 4. Complete Sync Capability Matrix

Legend: FULL / PARTIAL / CREATE-ONLY / LOCAL-ONLY / NOT-SYNCED / DANGEROUS.
Re-verified at plan time: voucher route has NO cancel enqueue (only `enqueueVoucherCreate`
import + call); expense materialize has NO dep step; `ensureDeps` has NO transaction;
cashbox route has ZERO enqueue references.

| Domain | Class | Local → outbox → push → hub → materialize → pull | Idemp. | Order/dep | Conflict | Reject/restart/replay/2-device |
|---|---|---|---|---|---|---|
| party/customer/supplier | PARTIAL | yes→yes→yes→yes→upsert | id | must precede docs (snapshots) | none (Strategy B) | fail→retry; dup→`exists`; same-code→`failed` until blocks cover |
| fabric / color / roll | PARTIAL | yes→yes→yes→yes→upsert (color needs fabricId, roll needs colorId) | structural→`invalid` | yes | none as entities; roll IS the contested resource | malformed→dead (correct, no wedge) |
| invoice sale/entry create | PARTIAL+ | yes→yes→yes→FWW `roll:*`→pre-allocated replay | id+number | masters via snapshots | FWW per-roll, qty-blind | 409→local cancel+notify (sole rollback); dup→`exists`; lease reclaim |
| invoice update | PARTIAL | yes→yes→yes→`invoice_update_roll`→replay full updateInput | non-convergent, no base version | create-first (missing→`failed`) | separate ns — never blocks create | 409→NO rollback, local stays edited |
| invoice cancel | PARTIAL | yes→yes→yes→`invoice_cancel`→cancel use-case | cancelled→`exists` | create-first | own ns; releases roll claims (best-effort) | release best-effort only |
| order create/cancel | PARTIAL | yes→yes→yes→per-doc-id only→replay | id+code | masters needed, NO snapshots | NO shared claims — same-stock orders never conflict | divergence without 409 |
| voucher create | CREATE-ONLY | yes→yes→yes→`voucher:<id>`→replay | id | party needed, NO snapshot | per-doc-id; cash/ledger legs unguarded | 409→no rollback |
| voucher cancel | NOT-SYNCED | yes→**NO**→—→—→no branch | n/a | — | none | permanent peer divergence |
| return create/cancel | PARTIAL | yes→yes→yes→`return_roll`/`return_cancel`→replay | id | sale-first (missing→`failed`) | qty-blind | 409→no rollback |
| expense create/cancel | PARTIAL | yes→yes→yes→per-doc-id→replay (no dep step) | id+number | none | none shared | 409→no rollback |
| cashbox/sessions/day-close/manual | NOT-SYNCED | yes→NO | — | — | none | balances diverge; day-close meaningless multi-device |
| direct stock/ledger writes | NOT-SYNCED | only via doc replay | — | — | doc-claims only | direct writes bypass sync |
| print jobs/rolls | NOT-SYNCED | yes→NO | — | — | none | unsynced |
| statements/settlements | NOT-SYNCED | `SET` prefix, no block size, no enqueue | — | — | none | unsynced |
| settings/company; users/roles/invitations | NOT-SYNCED (policy undecided) | yes→NO | — | — | none | silent fork; security-relevant |
| notifications/audit | LOCAL-ONLY | yes→NO (correct) | — | — | — | keep local; document |
| attachments | NOT-SYNCED | yes→NO | — | — | none | peer docs referencing files break |
| numbering/blocks | PARTIAL | 4/8 auto-provisioned | yes | — | unique constraints | 4 types on shared fallback |
| FX reference/cache | UNKNOWN | NO; replay reuses `createInput` (rate structurally preserved, unpinned by test) | — | — | — | restatement risk |
| licensing/device registry | LOCAL-ONLY | n/a (`(tenant,fingerprint)` idempotent) | — | — | — | exclude; but reinstall orphans blocks/cursors |

Universal row behavior: duplicate POST/unit/inbox row → `(tenant,opId)` dedupe;
restart push → lease reclaim; restart pull → cursor resume; hub/PG restart → same.

## 5. Root-Cause Gap Register

| ID | Title (Severity · Category) — Current → Expected · Root cause · File:Line | Fix direction · Regression risks |
|---|---|---|
| SYNC-01 | Voucher cancel never enqueued (P0 · coverage). Cancel calls use-case directly (`voucher.route.ts:208-227`, verified: no enqueue) while create enqueues (`:99`); no `voucher/cancel` materialize branch (`syncMaterialize.ts:139` create-only). → cancel must converge like return-cancel. Root cause: cancel path added without sync wiring. Affects voucher/accounting/ledger/balances. | Add `enqueueVoucherCancel` + `materializeVoucherCancel` mirroring return-cancel (`return.route.ts:154`, `syncMaterialize.ts:356-379`); `voucher_cancel` claim ns already defined. Risk: old peers emit no cancel — mixed-version run required. |
| SYNC-02 | Voucher/order/expense carry no dependency snapshots (P0 · ordering). Capture only invoice/return (`syncDependencySnapshots.ts:95,268`); voucher/order `ensureDeps` no-ops on absent deps; expense has no dep step (verified). Offline party+voucher → hub `failed`×5→`dead`. → deps-first convergence for money units. | Extend capture/ensure to voucher/order/expense (party minimum; reuse `ensureInvoiceSyncDependencies`). Risk: payload growth — referenced rows only. |
| SYNC-03 | Loser rollback missing for 12/13 kinds (P0 · reconciliation). `rollbackRejectedUnitLocally:724-764` handles only `invoice/create`; rest notification-only → rejected device keeps hub-rejected records. → every 409 leaves cancelled/flagged local state + record. | Per-entity rollback (cancel-created docs via cancel use-cases; update-losers flagged + guided re-entry; never delete). Risk: cancel may fail on settled docs → manual queue, never silent. |
| SYNC-04 | Roll FWW quantity-blind (P0 · conflict). `extractConflictResources:771-806` claims whole `roll:<id>`; release only on cancel. Part-quantity second sale always 409. → quantity-aware FWW. | Claim carries `quantityKg`; second claim wins iff `claimed+requested ≤ hub-available` in the same `tryClaimAll` tx; over-claim 409 with `available`. Only change touching claim semantics; keeps determinism (no LWW/merge — mathematically required for stock). Risk: availability read pinned to claim-tx snapshot. |
| SYNC-05 | Block auto-provisioning incomplete (P1 · numbering). `PRIMARY_ENTITY_TYPES` lacks voucher/return/expense/order (`numberBlockUseCases.ts:27-32`) → shared-sequence fallback + warn. → all 8 types provisioned. | Add the four types. Risk: exhaustion on small defaults — monitored via `missingBlocks`. |
| SYNC-06 | Replay trusts wire `actorRole` (P1 · security). `replayCtxFromPayload:74-98` executes with payload role. → hub resolves role from its own store; payload id is attribution only. | Single choke-point fix. Risk: legacy payloads w/o resolvable user → minimal privilege + visible `failed`. |
| SYNC-07 | Pull exclusion self-reported (P1 · security). `GET /sync/pull` trusts query param; safety rests on per-path `exists` guards. → hub derives exclusion from authenticated device binding. | Trust-boundary hardening. Risk: negligible; normal pulls unaffected. |
| SYNC-08 | `ensureInvoiceSyncDependencies` not transactional (P1 · atomicity). `runWithTenantContext` only, no `db.transaction` (verified `:414`) → crash leaves half-applied dep sets. → wrap in one `db.transaction`. | Smallest atomicity fix; retry path unchanged. Risk: slightly longer small tx. |
| SYNC-09 | Stuck-claim leakage unobservable (P1 · operations). Best-effort cancel-scoped release (`616-643`); crash strands claims; no inventory. → claim inventory + terminal-state-only audited reap. | Reap-by-terminal-state can't break determinism (TTL reap could). Risk: none if terminal-gated. |
| SYNC-10 | Invoice update non-convergent (P1 · conflict). Full `updateInput` replay, no base version; concurrent edits silent-LWW; 409 unreconciled. → `baseVersion`, stale→retryable failure with diff, UI rebase, never auto-merge. | Preserves edit intent for money docs. Risk: legacy clients omit base → clear-message reject. |
| SYNC-11 | No update/restore/reinstall safety for sync state (P1 · recovery). Identity in localStorage; no pending-preserving update, restore, or rebind procedure/drill. → version-tolerant payloads (pinned), procedures + drills. | Procedural + small binding change. Risk: must not orphan in-flight units. |
| SYNC-12 | Cashbox/day-close/movements unsynced (P1 · coverage). Zero enqueue refs (verified count 0). → cash-movement units + day-close serial claim per tenant-day, replay via cashbox use-cases. | Same doc-pattern as vouchers. Risk: close-vs-movement race — close claims day bucket first. |
| SYNC-13 | 10+ domains lack declared sync policy (P2 · coverage). settings/company/users/roles/invitations/attachments/print/statements: no enqueue, no local-only decision. → per-domain decision + policy-as-code test. | Decision + enforcement test. Risk: none technically; needs owner sign-off. |
| SYNC-14 | Historical FX/COGS preservation unproven (P2 · accounting). Rate structurally preserved via `createInput` but no pinning test. → invariant tests per doc type. | Test-only unless pins fail. Risk: none. |
| SYNC-15 | Trigger drops runs + swallows pull errors (P2 · operations). `runSyncNow` overlap→null; `/sync/run` pull failure warn-only (`sync.route.ts:175-177`); no backoff. → honest run results + backoff. | Observability fix. Risk: UI must handle new result shapes. |
| SYNC-16 | Single-tenant-wide push lane stalls on poison unit (P2 · ordering/scale). Tenant-wide seq order; push has no dead-letter escape (pull does). → per-type lanes or skip-with-hint (deferred; safe but slow today). | Later optimization; do AFTER correctness phases. Risk: must preserve determinism. |

Speculative / VERIFICATION REQUIRED (not confirmed gaps): hub production identity and
star-topology confirmation; `preAllocatedId/Number` concurrency in non-invoice use-cases;
COGS source-rate provenance per invoice type; day-close-with-pending policy; settlement
lifecycle (synced vs hub-computed); production block sizes; legacy-payload privilege
fallback — all carried in §16 with owners.

## 6. Data Integrity / Accounting / Inventory Risk Matrix

| Domain | Synced? | Authoritative | Recalculated? | Replayed? | Snapshot? | Diverge / duplicate / lose / corrupt |
|---|---|---|---|---|---|---|
| Inventory | via docs + dep rewind | hub post-apply | `remaining_kg` by direction | yes | pre-effect remaining | qty-blind rejects (SYNC-04); direct writes bypass; half-deps visible (SYNC-08) |
| Sales / purchases | yes c/u/x | hub applied copy | no | yes pre-allocated | full `createInput` + deps | dup guarded; lose only via visible dead; updates LWW (SYNC-10) |
| Returns | yes c/x | hub | legs re-derived | yes | `createInput` + deps | guarded; cancel releases claims |
| Vouchers | create yes / cancel NO | hub (creates); cancels local-only | re-derived on replay | create yes | `createInput`, no party snapshot | cancels corrupt balances (SYNC-01); legs unguarded |
| Cashbox | NO (doc legs derived) | per-device | n/a | n/a | none | free divergence (SYNC-12) |
| Ledger | derived for synced docs; direct journals NEVER sync | hub for replayed legs | re-posted on replay | yes | via `createInput` | dup guarded by doc idempotency; direct journals lost to peers |
| Customer/supplier balances | derived | hub post-convergence | recomputed | via docs | party snapshot (opening balance not re-journaled — by design) | voucher-cancel gap corrupts |
| COGS / historical FX | structurally preserved, UNPINNED | original doc | MUST NOT be | n/a | currency in snapshot | restatement risk (SYNC-14) |
| Numbering | 4/8 blocked | hub floor via `applyPreAllocatedNumber` | no | passthrough | per-device ranges | 4 types collide-prone (SYNC-05); cancelled numbers never reused (correct) |

Iron rule for all repair work: **no fix may recalculate a posted amount, balance, or
COGS leg with any rate/value other than the one stored at posting time.** Every
money-touching phase carries an FX-pinning assertion.

## 7. Final Ordered Repair Sequence

Order is dependency-derived: a later phase never depends on an unresolved semantic
contract from an earlier one. For each phase: objective, issues, why-here, files,
order, proofs, regression, exit.

**P1 — Reconciliation safety (SYNC-03 + SYNC-09).** Why first: every later phase
produces rejections/dead units; without reconciliation + claim visibility each fix
multiplies silent divergence. Files: `syncUseCases.ts` (rollback, status),
`sync.route.ts` (status + new claims endpoints), `PostgresSyncResourceClaimRepository.ts`,
per-entity cancel use-cases. Order: claim inventory → per-entity rollback →
terminal-state reap. BEFORE: live 409 on non-invoice type → local record stays active
(API + DB proof); stranded claim with no API visibility. FIX: §5/SYNC-03 + SYNC-09.
AFTER: per-entity 409 E2E (cancelled/flagged + `kind='sync'` notice); crash sim → reap
clears only terminal claims. REGRESSION: invoice-create rollback, all green suites.
EXIT: no rejected unit leaves active local doc without resolution record; claims
nameable/clearable without SQL.

**P2 — Ordering correctness (SYNC-02 + SYNC-08).** Why here: newly-reconciled units
need dependency convergence; atomic dep-sets before quantity logic reads stock.
Depends: P1. Files: `syncDependencySnapshots.ts`, `syncMaterialize.ts`
(voucher/order/expense), route capture call-sites. BEFORE: offline party+voucher,
push voucher first → `failed`×5→`dead` while party in flight (hub inbox proof);
kill-mid-ensure → half-applied masters (DB proof). AFTER: reordered arrival converges,
never `dead` while dep in flight; kill-mid-ensure all-or-nothing. REGRESSION: P1
suites + invoice/return dep paths. EXIT: §5/SYNC-02 + SYNC-08 acceptance met.

**P3 — Conflict correctness (SYNC-04 + SYNC-10).** Why here: 409s now reconciled and
ordered, so new 409 semantics land safely. Depends: P1–P2. Files: `syncUseCases.ts`
(claim input), `PostgresSyncResourceClaimRepository.ts` + quantity migration,
invoice-update payload/route. BEFORE: two part-quantity same-roll sales → exactly
201+409 with remainder available (concurrency proof); concurrent edits → silent
overwrite (DB proof). AFTER: exact-fit both apply; over-claim 409 carries remainder;
stale edit → diff-bearing retryable failure, UI rebase. REGRESSION: P1–P2 suites.
EXIT: both acceptances under parallel load.

**P4 — Numbering completeness (SYNC-05).** Why here: fewer 409s → stable numbering
demand. Depends: P3. Files: `numberBlockUseCases.ts`, block repo, status. BEFORE:
offline voucher mint on unprovisioned device → fallback warning in logs. AFTER:
two-device offline mint all 8 types → distinct, both apply. REGRESSION: invoice/party
block paths. EXIT: zero fallback warnings in normal operation.

**P5 — Missing entity coverage (SYNC-01 + SYNC-12 + SYNC-13).** Why here: new units
inherit rollback/ordering/conflicts/numbering. Depends: P1–P4. Files:
`voucher.route.ts`, `cashbox.route.ts` + use-cases, `syncEnqueue.ts`,
`syncMaterialize.ts` dispatcher, policy doc + allow-list test. BEFORE: voucher cancel
on A → hub/B unchanged (API proof); cash movement → hub absent. AFTER: per-entity
converge E2E; policy-as-code green. REGRESSION: all prior suites. EXIT: matrix has no
undeclared NOT-SYNCED/UNKNOWN rows.

**P6 — Security hardening (SYNC-06 + SYNC-07).** Why here: all replay paths exist
before locking the choke point. Depends: P5. Files: `syncMaterialize.ts`
(`replayCtxFromPayload`), user lookup, `sync.route.ts` pull, `auth.middleware.ts`.
BEFORE: forged-role push executes privileged (staging proof); spoofed
`excludeSyncDeviceId` alters pull set. AFTER: forged role stays unprivileged; spoofed
param ignored. REGRESSION: RLS + journal guards + all E2E. EXIT: no unit executes with
hub-ungranted privilege.

**P7 — Operations honesty + recovery procedures (SYNC-09 remainder + SYNC-11 +
SYNC-15).** Why here: stable semantics to document. Depends: P1–P6. Files:
`src/lib/sync-engine.ts`, `hooks/useAutoSync.ts`, run handler, runbook, status UI.
BEFORE: overlapping runs silently drop; hub-down reports ambiguous success. AFTER:
honest run results, backoff, drilled update/restore/reinstall procedures. REGRESSION:
full gate. EXIT: every operability question answerable from API/UI alone.

**P8 — Accounting lock-in + full gate (SYNC-14 + SYNC-16 decision).** Why last: proves
money on top of finished semantics. Depends: all. Files: test-only (+fixes if pins
fail). BEFORE: rate-change-then-sync ledgers compared across nodes (any delta =
defect). AFTER: FX pins green per doc type; §15 gate all green on clean artifact.
EXIT: production gate passes.

## 8. Serial vs Parallel Work

- MUST BE SERIAL: P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8. Each phase redefines
  409/dead/cursor/claim meaning for the next; concurrent edits to the same semantics
  collide even without git conflicts. One issue at a time inside a phase:
  READ → UNDERSTAND → REPRODUCE → FIX ROOT CAUSE → TEST → E2E → VERIFY DATA →
  REGRESSION → ACCEPT → NEXT.
- SAFE IN PARALLEL: per-entity units inside P5 after contracts freeze; test-authoring
  vs implementation within a phase; frontend status-display vs backend P1–P2 (coordinate
  field names once); SYNC-14 pin-writing vs P5–P6 implementation (read-only).
- BLOCKS OTHER WORK: P1 blocks all (reconciliation contract); P3 blocks P5
  (quantity-aware claims); P6 blocks release (role fix); P8 blocks the gate.
- Hotspots (one writer at a time, from current repo): `syncUseCases.ts`,
  `syncMaterialize.ts`, `syncDependencySnapshots.ts`, `sync.route.ts`,
  `PostgresSyncResourceClaimRepository.ts`, `documentNumbers.ts` + block repo,
  `drizzle.ts`/`ambient-tx.ts`, `auth.middleware.ts`, `syncEnqueue.ts`.
  Parallel agents on these files simultaneously is prohibited; split by phase, not file.
  For parallel tasks elsewhere, the boundary is: shared semantic contracts
  (409 meaning, dead meaning, cursor advance rule, claim namespace set) are frozen in
  the phase's first commit and any change requires phase-owner review.

## 9. Unified Verification Strategy

One strategy; each repair phase adds its regression protection. Goal is NOT "tests
pass" but: **all business invariants hold under normal, concurrent, offline, failure,
restart, replay, upgrade, and recovery conditions.**

- Static invariants (extend `sync-invariants.test.ts`, DB-free): dispatcher
  exhaustiveness; every write route enqueued-or-allow-listed; no swallowed enqueues;
  seq-cursor presence; `invalid`≠`applied`; retryable-set membership; no
  role-from-payload (post-P6).
- Unit + repository (live PG, skip-if-unreachable): claim acquire/release/reap; lease
  reclaim; attempts→dead; cursor advance/hold.
- Integration (single node): F-07-style injected-enqueue-failure atomicity;
  kill-mid-ensure atomicity; block fallback behavior.
- Multi-DB E2E hub/A/B (successors of `verify-sync-multidevice.mjs`,
  `test-f08-resource-claims.mjs` — note: F-08 script header is stale F-07 copy-paste,
  body authoritative): converge, idempotent replay, exact-fit/over-claim, stale-pushing
  reclaim, 401-then-recover, out-of-order converge, per-entity 409→rollback, P5
  converges. Baseline claims in historical docs (32/32, 29/30 with 1 F-08-attributed
  failure, 3/3 claim-release, first live run 15/27) are NOT inherited — re-run all.
- Concurrency / out-of-order / duplicate-replay / timeout / restart / crash / PG+hub
  restart / dead-letter / reconnect: per §§7/10 matrices.
- Accounting + inventory invariants + FX preservation + numbering uniqueness (§§6/10).
- Tenant isolation + device security (RLS guards, forged-role/spoofed-exclude suites).
- Backup/restore + update/migration + offline-operation drills (§11).

## 10. Offline-First E2E Strategy

Same harness as §9, offline-flavored: device works with hub unreachable (role matrix
enforced: admin/accountant write, warehouse/viewer read-only); pending outbox survives
SIGKILL/reboot/update/restore; long-offline (simulated hours/days of backlog, 50-unit
batches) drains deterministically; offline-created entity referenced by later offline
op converges (dep snapshots); offline numbers unique across devices; reconnect fires
push-then-pull once and reports honestly; conflict-after-long-offline reconciles via
P1 contracts (no silent loss); mixed-version window tolerated (unknown pairs →
`invalid`/dead, never silent apply).

## 11. Backup / Restore / Update / Migration Safety

Pending outbox/inbox, `sync_state` cursors, claims, number blocks, and device identity
are durable production state, not caches. Rules: never truncate sync tables
independently; hub upgrades first, then devices; migrations additive
(`ADD COLUMN IF NOT EXISTS` pattern); journal density + fresh-migrate + re-run-no-op
guards stay green; `apply-rls` needs an automated/CI step (currently manual — P7);
update-with-pending, restore-with-pending, and reinstall-rebind drills required (P7);
downgrade = stop devices + restore hub snapshot including sync tables. RLS change
(`0029` NULLIF) ships through the same automated step everywhere.

## 12. Security / Tenancy / Device Safety

RLS FORCE on all six sync tables; tenant from verified JWT only; device header
opportunistic and validated; registration keyed `(tenant,fingerprint)`; every repo call
under `runWithTenantContext`; GUCs stamped per checkout + `SET LOCAL` per tx. Repair
impact: P6 closes wire-role trust (SYNC-06) and self-reported exclusion (SYNC-07);
P5 must not extend replay to users/roles without owner sign-off (privilege-relevant);
reap endpoint (P1) is tenant-scoped + audited; claim-quantity migration (P3) keeps the
unique constraint (no new bypass surface). Verify: RLS guards, journal guards,
forged-role suite, spoofed-exclude suite, cross-tenant probe.

## 13. Observability and Operator Recovery

Existing: `/sync/status` (pending counts, inbox counts, blocks, `missingBlocks`),
`/sync/inbox`, `/sync/pending`. P1 adds claim inventory + audited reap. P7 adds honest
run results (no silent overlap-drop, pull errors surfaced) and backoff. Operator must
be able to answer from API/UI alone: which device offline/behind/lagging; pending
count; rejected/dead units + why; conflicting resource + winner; stuck claims + age;
what needs hands. Every dead/rejected unit links to its resolution record (P1). No
over-engineering: no new metrics pipeline — PG-backed endpoints + existing runbook.

## 14. Clean Release / Production Preparation

Tree is dirty (≈30 modified incl. sync use-cases/routes/RLS/schemas/auth, ≈20
untracked incl. `ambient-tx.ts`, migrations `0052-0054`, sync tests, verify scripts).
Steps: (1) classify every delta into SYNC / non-sync / docs-only / generated —
non-sync ships separately or not at all; (2) claim migrations `0052-0054` + P3
quantity migration belong to the release; journal-density + fresh-migrate + no-op
guards; (3) `enable-rls.sql` via one automated step everywhere; (4) rebuild generated
artifacts (desktop bundles, dist) from clean checkout — never ship working-tree
`target/`/`node_modules/`/`dist/`; (5) hub-first deploy order; mixed-version covered
by P7–P8 tests; (6) reproducibility: clean clone + `npm ci` + migrate + seed +
`check:all` + §9 gate = production artifact; (7) rollback: additive migrations only;
downgrade via hub snapshot restore including sync tables. Nothing committed now.

## 15. Final Production Gate

All hold on a clean artifact (hub + 2 devices, full E2E) before declaring
SYNC + OFFLINE-FIRST = PRODUCTION READY: real offline writes per role matrix; durable
local persistence + outbox (kill/reboot/update/restore drills); reconnect drains
honestly; idempotent exactly-once effects; deterministic ordering; dependency safety
(never `dead` while dep in flight; atomic dep-sets); quantity-aware conflicts, no
silent LWW; every 409 reconciled with record; zero silent divergence; inventory
conserved; ledger/balances/COGS match across nodes; FX pins green (no restatement);
numbering unique with visible exhaustion; device/hub/PG restart recovery; dead-letter
visible + terminal-only reap; backup/restore + update + migration drills; tenant
isolation + device security suites; observability questionnaire answerable; operator
procedures drilled; clean build from clean checkout; clean production DB.

## 16. Unknown / Verification Required

1. Hub production identity; star-topology (hub never pulls) owner confirmation.
2. `preAllocatedId/Number` concurrency in non-invoice use-cases (staging probe).
3. COGS source-rate provenance per invoice type (finance owner + probe).
4. Day-close with pending outbox allowed? (policy decision, P5 input).
5. Settlement lifecycle: synced entity vs hub-computed report? (owner decision).
6. Production block sizes + exhaustion policy (current defaults are guesses).
7. Legacy-payload privilege fallback post-SYNC-06 (owner sign-off).
8. `erp` database upgrade failure at `0032` (stale `__drizzle_migrations`) and
   `licensing-engine basic→[inventory,accounting]` mismatch noted in
   `VERIFICATION_RESULTS_P0.md` — adjacent, verify before release.

## 17. FIRST IMPLEMENTATION TASK

**P1-step-1: per-entity loser rollback + claim inventory/reap (SYNC-03 + SYNC-09).**

- Exact objective: no rejection leaves silent divergence; every stuck claim is visible
  and terminal-only clearable.
- Exact root cause: `rollbackRejectedUnitLocally` (`syncUseCases.ts:724-764`) handles
  only `invoice/create`; all other 12 kinds fall through to notification-only, so the
  losing device keeps a hub-rejected record. Claims release only on invoice/return
  cancel, best-effort, with no inventory endpoint.
- Exact files: `backend/src/application/use-cases/sync/syncUseCases.ts` (rollback fn,
  `getSyncStatus`), `backend/src/presentation/routes/sync.route.ts` (status + new
  `GET /sync/claims` / `POST /sync/claims/reap`), `backend/src/infrastructure/
  repositories/PostgresSyncResourceClaimRepository.ts` (reap query), per-entity cancel
  use-cases (reuse existing), `backend/tests/sync-invariants.test.ts` (new pins).
- Prerequisites: none (reads existing 409 paths; touches no money logic).
- Before-fix proof: on staging hub/A/B — push conflicting non-invoice unit (e.g. two
  devices same-roll returns), observe 409 on loser with local record still active
  (GET + DB row proof); query `/sync/status` — no claim inventory present.
- Expected fix: per-entity rollback (cancel-created docs via their cancel use-cases;
  update-losers flagged + guided re-entry; never delete); claim inventory in status;
  audited reap limited to terminal (`dead`/rejected-op) claims.
- After-fix proof: per-entity 409 E2E — each loser ends cancelled/flagged with
  `kind='sync'` notice (API + DB proof); crash-simulation — reap clears only terminal
  claims, live claims untouched (DB proof before/after).
- Acceptance criteria: (1) all 13 operation kinds covered; (2) zero rejected units
  leave active local docs without resolution records; (3) reap terminal-gated +
  audited; (4) no money revaluation anywhere in this step; (5) §9 layers 1–4 green,
  no prior-suite regressions.
- Regression suite: `sync-invariants` (incl. new pins), `sync-claim-release`,
  `rls-guard`, `migrations-journal-guard`, F-07 atomicity script, multidevice script
  (re-run, not inherited), invoice-create rollback path.
