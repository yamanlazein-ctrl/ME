MOTARD ERP — COMPLETE REMEDIATION PLAN
Ordering: dependency-first (foundation), then P0 → P1 → P2 → P3. Each item is independently executable and independently verifiable.

Legend for every item
Problem · Evidence · Origin file/fn/SQL · Root cause · Dependents · Cascading effects · Data-flow · Fix architecture · Changes · Obsolete/consolidate · DB/API/FE/Desktop/Sync/License impact · Tests + runtime verification · PASS criteria · Regression checks.

FOUNDATION (must precede P0 sync work — they touch the same schema/replay)
FND-1 — Single source of truth for schema (kill ensureDesktopSchema drift)
Problem/Evidence: Two schema bootstraps exist: Drizzle migrations and raw CREATE TABLE IF NOT EXISTS at server start, because baked pgdata-template predates the sync protocol. ensureDesktopSchema.ts:19-23 REMEDIATION_LOG.md:49
Origin: backend/src/infrastructure/orm/ensureDesktopSchema.ts; called from server.ts:350-515.
Root cause: Baked template shipped stale; runtime patching used instead of re-baking the template + running migrations on boot.
Dependents: every sync table (sync_*, document_number_blocks), RLS policies, all sync repositories.
Cascading effects: hand-written DDL can diverge from migration DDL (column types, indexes, RLS FORCE), producing silent schema drift between web and desktop.
Fix architecture: make Drizzle migrations the ONLY DDL authority; on desktop boot run the migration runner against the live DB (idempotent) instead of bespoke SQL; re-bake pgdata-template from a migrated DB in CI so the template is never behind.
Changes: replace ensureDesktopSchema() body with a call to the standard migration runner; add a CI step that builds pgdata-template by initdb + running all migrations; delete the divergent raw DDL.
Consolidate/remove: remove ensureDesktopSchema.ts raw DDL once the migrated template is verified.
Impact: DB + Desktop.
Tests/verification: boot desktop from a fresh baked template; assert information_schema for every sync table matches the migration-defined schema; assert RLS relforcerowsecurity=true for all tenant tables.
PASS: diff of live desktop schema vs a freshly-migrated web schema is empty; no code path other than migrations issues DDL.
Regression: existing sync E2E still green; cold boot still succeeds.
FND-2 — Reconcile migration/journal skew (0046 file vs journal jump)
Problem/Evidence: migration file 0046 exists (user_pin_hash) but the Drizzle journal jumps 0045→0047. REMEDIATION_LOG.md:57
Origin: backend/src/infrastructure/orm/migrations/ + meta/_journal.json.
Root cause: manual migration file added without journal entry (or vice versa).
Dependents: migration runner ordering; FND-1 depends on a consistent journal.
Cascading: a fresh DB may skip or double-apply 0046 depending on runner; desktop template baked from a skewed journal.
Fix: audit _journal.json vs on-disk NNNN_*.sql; regenerate journal so every file has exactly one ordered entry; verify checksums.
Impact: DB.
Tests: run migrations on an empty DB; assert all 0001–0051 apply exactly once; user_pin_hash column present.
PASS: runner reports N applied = N files; no gaps.
Regression: existing DBs migrate forward without error.
P0 — CORRECTNESS / DIVERGENCE
P0-1 — Rust and Node device-fingerprint algorithms are incompatible (FINDING-001)
Problem/Evidence: Rust comment claims "Deterministic SHA-256 … same pattern as NodeFingerprintProvider" but the implementation uses DefaultHasher (SipHash, non-crypto, short hex). main.rs:222-223 main.rs:243-246 Node uses real SHA-256 over a differently-shaped payload. NodeFingerprintProvider.ts:111-122 Different signal keys on each side. main.rs:238-241
Origin: desktop/src-tauri/src/main.rs get_fingerprint.
Root cause: placeholder hash left in; comment copied without matching implementation.
Dependents: src/lib/license-state.ts::getServerFingerprint (returns Rust hash inside Tauri) license-state.ts:208-217 ; hub registerDeviceOnHub (Node hash) numberBlockUseCases.ts:312-331 ; sync_devices / device_registrations uniqueness; activation x-device-fingerprint proof path auth.route.ts:106-171 .
Cascading: (a) deviceFingerprintVersion=1 on both → silent incompatibility; (b) same machine gets two identities depending on register path; (c) DefaultHasher is not stable across Rust std versions → toolchain bump silently re-fingerprints every install; (d) short {:x} output can drop below the min-16 schema length → intermittent 400 on /api/auth/sync-device. auth.schema.ts:31-33
Fix architecture: define ONE canonical fingerprint spec (exact signal key set, ordering, JSON shape, SHA-256, hex64, version integer). Implement it identically in Rust (sha2 crate) and Node; bump deviceFingerprintVersion to 2; treat v1 as legacy/unmatched.
Changes: rewrite Rust get_fingerprint to sort keys, JSON-serialize the canonical {platform,version,signals}, SHA-256, lowercase hex; align Node key names to the canonical set; add a shared spec doc.
Consolidate/remove: remove the DefaultHasher path entirely.
Impact: Desktop, License, Sync, DB (fingerprint columns), API.
Tests/verification: add a cross-layer parity test with a fixed signal fixture → Rust output == Node output == known vector; extend fingerprint.test.ts (currently Node-only) fingerprint.test.ts:18-23 . Run on a real machine: register via desktop and via hub → same device_fingerprint.
PASS: identical 64-hex output for identical signals across Rust and Node; length always ≥16; stable across a Rust minor-version rebuild (pin via test vector).
Regression: existing device rows must be migration-mapped or version-flagged so caps don't double-count; activation proof path still authorizes valid devices.
P0-2 — Voucher cancel never enqueued to sync (SYNC-01)
Problem/Evidence: create enqueues (voucher.route.ts:99) but cancel calls the use-case directly (voucher.route.ts:208-227, no enqueue); syncMaterialize.ts:139 has create-only, no voucher/cancel branch. SYNC-MASTER-REPAIR-PLAN.md:137
Origin: backend/src/presentation/routes/voucher.route.ts cancel handler; syncMaterialize.ts.
Root cause: cancel path added later without sync wiring.
Dependents: ledger, party balances, statements, profit, peer devices.
Cascading: permanent multi-device divergence of accounting balances (cancelled on origin, still active on peers).
Fix architecture: mirror return-cancel: add enqueueVoucherCancel + materializeVoucherCancel (the voucher_cancel claim namespace already exists), modeled on return.route.ts:154 / syncMaterialize.ts:356-379.
Impact: Sync, DB, accounting.
Tests: two-device: cancel voucher on A → assert peer B converges (voucher inactive, balances match); replay idempotent.
PASS: post-cancel, both devices show identical party balance and ledger active-leg set.
Regression: mixed-version peers (old emits no cancel) handled gracefully; create-voucher sync unchanged.
P0-3 — Loser rollback missing for 12 of 13 unit kinds (SYNC-03)
Problem/Evidence: rollbackRejectedUnitLocally:724-764 handles only invoice/create; other kinds are notification-only → rejected device keeps hub-rejected records. SYNC-MASTER-REPAIR-PLAN.md:139
Origin: syncMaterialize.ts::rollbackRejectedUnitLocally.
Root cause: rollback implemented per-entity for only the first kind.
Dependents: every non-invoice sync kind (voucher/return/order/expense/…).
Cascading: after a 409, loser device retains cancelled/flagged local docs that never existed on the hub → permanent local phantom records.
Fix architecture: per-entity rollback — cancel created docs via their cancel use-cases; update-losers flagged with guided re-entry; NEVER hard-delete. On failure (settled doc) route to a manual queue, never silent.
Impact: Sync, DB.
Tests: force a claim conflict for each kind; assert loser local state reverts (or is flagged) and no orphan record remains.
PASS: for all 13 kinds, a rejected unit leaves no divergent local record; settled-doc rollback lands in an observable manual queue.
Regression: invoice/create rollback behavior unchanged.
P0-4 — Roll first-writer-wins is quantity-blind (SYNC-04)
Problem/Evidence: extractConflictResources:771-806 claims the whole roll:<id>; released only on cancel; a partial second sale of the same roll always 409s. SYNC-MASTER-REPAIR-PLAN.md:140
Origin: claim extraction + PostgresSyncResourceClaimRepository.tryClaimAll:29-154. SYNC-MASTER-REPAIR-PLAN.md:56
Root cause: claim models a roll as a single indivisible resource rather than a quantity.
Dependents: inventory, COGS, invoice sync, any two-device partial-roll sale.
Cascading: legitimate concurrent partial sales of one roll are blocked; forces manual work; undermines offline multi-device selling.
Fix architecture: claim carries quantityKg; second claim wins iff claimed + requested ≤ hub-available inside the same tryClaimAll tx; over-claim returns 409 with available. Availability read pinned to the claim-tx snapshot. Keep deterministic (no LWW/merge — mathematically required for stock).
Impact: Sync, inventory, COGS.
Tests: two devices each sell part of one roll offline → both converge if sum ≤ available; over-claim → deterministic 409 carrying remaining available.
PASS: concurrent partial sales summing within stock both apply on all devices; over-sale rejected with correct remaining quantity.
Regression: whole-roll conflict still resolves FWW; claim release on cancel still works.
P0-5 — Voucher/order/expense carry no dependency snapshots (SYNC-02)
Problem/Evidence: capture only invoice/return (syncDependencySnapshots.ts:95,268); voucher/order ensureDeps no-op on absent deps; expense has no dep step. Offline party+voucher → hub failed×5 → dead. SYNC-MASTER-REPAIR-PLAN.md:138
Origin: backend/src/application/use-cases/sync/syncDependencySnapshots.ts.
Root cause: dependency capture built only for the first two entity types.
Dependents: party, voucher, order, expense materialization ordering.
Cascading: an offline-created party referenced by an offline voucher never converges → money unit dead-lettered → permanent divergence.
Fix architecture: extend capture/ensure to voucher/order/expense (party minimum), reusing ensureInvoiceSyncDependencies; send only referenced rows to bound payload growth.
Impact: Sync.
Tests: offline create party + voucher on A → both converge on B without dead-lettering.
PASS: no dead units for deps-first money-unit scenarios across all four entity types.
Regression: invoice/return dependency capture unchanged; payload size bounded.
P1 — INTEGRITY / SECURITY / OPERATIONS
P1-1 — Cashbox / day-close / movements unsynced (SYNC-12)
Evidence: zero enqueue references; balances diverge, day-close meaningless multi-device. SYNC-MASTER-REPAIR-PLAN.md:148 SYNC-MASTER-REPAIR-PLAN.md:119-123
Root cause: cashbox module never wired to outbox.
Fix: cash-movement units + day-close serial claim per tenant-day, replay via cashbox use-cases (doc-pattern like vouchers); close claims the day bucket first to serialize against movements.
Impact: Sync, cashbox, ledger.
Tests: two-device cash movements + one day-close → converge; close-vs-movement race resolves deterministically.
PASS: identical cashbox balance and day-close state on all devices.
Regression: single-device cashbox unaffected.
P1-2 — Number-block auto-provisioning incomplete (SYNC-05)
Evidence: PRIMARY_ENTITY_TYPES lacks voucher/return/expense/order (numberBlockUseCases.ts:27-32) → shared-sequence fallback + warn. SYNC-MASTER-REPAIR-PLAN.md:141
Root cause: four entity types omitted from provisioning list.
Fix: add the four types; monitor exhaustion via missingBlocks.
Impact: Sync numbering, DB.
Tests: provision all 8 types; assert per-device blocks issued, no shared-sequence fallback warning.
PASS: all 8 entity types get per-device blocks.
Regression: invoice numbering unchanged.
P1-3 — Sync replay trusts wire actorRole (SYNC-06, security)
Evidence: replayCtxFromPayload:74-98 executes with payload-supplied role. SYNC-MASTER-REPAIR-PLAN.md:142
Root cause: trust boundary: hub honors client-declared role.
Cascading: privilege escalation via forged sync payload.
Fix: hub resolves role from its own user store; payload user id is attribution only. Legacy payloads without resolvable user → minimal privilege + visible failed.
Impact: Sync, security, authz.
Tests: forged elevated role in payload → hub applies with the store-resolved role only.
PASS: payload role has zero effect on execution privileges.
Regression: legitimate replays still apply.
P1-4 — Pull exclusion self-reported (SYNC-07, security)
Evidence: GET /sync/pull trusts the excludeSyncDeviceId query param. SYNC-MASTER-REPAIR-PLAN.md:143
Root cause: exclusion derived from client input, not authenticated identity.
Fix: derive exclusion from the authenticated device binding.
Impact: Sync, security.
Tests: spoofed param → server ignores it and uses bound device id.
PASS: pull results depend only on authenticated device.
Regression: normal pulls unaffected.
P1-5 — ensureInvoiceSyncDependencies not transactional (SYNC-08)
Evidence: runWithTenantContext only, no db.transaction (:414) → crash leaves half-applied dep sets. SYNC-MASTER-REPAIR-PLAN.md:144
Root cause: missing transaction wrapper.
Fix: wrap the dep application in one db.transaction.
Impact: Sync atomicity, DB.
Tests: inject mid-apply failure → assert all-or-nothing.
PASS: no partial dependency sets after a crash.
Regression: retry path unchanged.
P1-6 — Stuck-claim leakage unobservable (SYNC-09)
Evidence: best-effort cancel-scoped release (616-643); crash strands claims; no inventory. SYNC-MASTER-REPAIR-PLAN.md:146
Root cause: no claim inventory / reaper.
Fix: claim inventory + terminal-state-only audited reap (NOT TTL — TTL would break determinism).
Impact: Sync operations.
Tests: crash mid-claim → claim visible in inventory; terminal-state reap releases it; non-terminal claims never reaped.
PASS: no permanently stranded claims; determinism preserved.
Regression: active claims never reaped.
P1-7 — Invoice update non-convergent (SYNC-10)
Evidence: full updateInput replay, no base version; concurrent edits silent-LWW; 409 unreconciled. SYNC-MASTER-REPAIR-PLAN.md:147
Root cause: no optimistic base-version on the sync update path.
Fix: carry baseVersion; stale → retryable failure with diff; UI rebase; never auto-merge money docs.
Impact: Sync, invoices.
Tests: concurrent edits on two devices → later edit rejected with diff, not silently overwritten.
PASS: no silent LWW on invoice edits; loser gets an actionable rebase.
Regression: legacy clients omitting base get a clear reject message.
P1-8 — No update/restore/reinstall safety for sync state (SYNC-11)
Evidence: identity in localStorage; no pending-preserving update/restore/rebind procedure or drill. SYNC-MASTER-REPAIR-PLAN.md:149 SYNC-OPERATIONS.md:109-115
Root cause: device identity + cursor stored fragilely; reinstall mints new id, orphaning number blocks and restarting cursor.
Fix: version-tolerant payloads (pinned), documented + drilled procedures for update/restore/rebind that preserve pending outbox and device identity.
Impact: Sync recovery, Desktop.
Tests: simulate update/restore/reinstall with pending outbox → no in-flight unit orphaned; identity preserved or cleanly rebound.
PASS: pending units survive an update; reinstall follows a documented rebind that avoids block orphaning.
Regression: normal boot path unchanged.
P1-9 — No updater; uninstall destroys data
Evidence: no tauri-plugin-updater, no plugins.updater; every MSI re-ships ~507MB; wix-cleanup.wxs:29-38 deletes %LOCALAPPDATA%\motard-erp on true uninstall. REMEDIATION_LOG.md:6-7
Status: SOURCE PARTIALLY IMPLEMENTED / WINDOWS LIFECYCLE UNVERIFIED. The Tauri updater plugin, signed endpoint configuration, check/install commands, and update-preserving runtime are present; signed publication, rollback, and uninstall backup/prompt behavior still require a packaged Windows drill.
Root cause: update/backup lifecycle not implemented (test-phase decision).
Cascading: no safe patching; accidental uninstall wipes live pgdata + secrets + binding.
Fix architecture: add tauri-plugin-updater with signed differential manifests + rollback; gate destructive uninstall behind an explicit user-confirmed data-export/backup step; keep upgrade DB-preserving.
Impact: Packaging, Desktop, data safety.
Tests: perform an in-place update (data preserved, versioned, rollback works); uninstall prompts and offers backup before deletion.
PASS: update applies without full re-ship and preserves data; uninstall cannot silently destroy live data.
Regression: upgrade still preserves DB; device binding survives update.
P1-10 — Long-lived tokens, no desktop revocation
Evidence: HS256 access 30m + refresh 365d in plain localStorage; revocation is Redis-or-no-op; Desktop ships without Redis. REMEDIATION_LOG.md:8
Root cause: revocation backend optional; desktop has no denylist store.
Fix: use the desktop PostgreSQL as the denylist store (persistent), shorten refresh lifetime, rotate on use with server-side revocation record.
Impact: Security, auth, Desktop.
Tests: logout on desktop → subsequent use of the old token rejected after restart.
PASS: revoked tokens fail server-side on desktop without Redis.
Regression: normal login/refresh unaffected.
P1-11 — Device-binding boot gate does not compare a live fingerprint
Evidence: design doc says refuse boot when decrypt succeeds but current fingerprint differs (VM clone/hardware change); ensure_device_binding only checks DPAPI decrypt + non-empty installation_id. LICENSE-ACTIVATION-PLAN.md:73-76 device_binding.rs:75-90
Root cause: fingerprint comparison specified but not implemented in the gate.
Dependents: depends on P0-1 (canonical fingerprint) landing first.
Fix: after successful decrypt, recompute the canonical fingerprint and compare against a value stored in the binding payload; mismatch → refuse boot with the documented message. Also decide/keep the "legacy 32-byte nonce adoption" branch deliberately (currently silently mints a new installation_id). device_binding.rs:37-90
Impact: Desktop, License, identity.
Tests: copy binding to a machine with different hardware signals → boot refused; same machine → boots.
PASS: hardware-change/clone refused per spec.
Regression: legitimate same-machine boots unaffected; legacy binding upgrade path defined and tested.
P1-12 — License enforcement skipped when no license row
Evidence: requireFeature calls next() when !lic. license.enforcement.middleware.ts:31-36
Root cause: setup-friendly bypass also covers a deleted/absent license row for an active tenant.
Fix: distinguish "setup in progress" (allow) from "active tenant with missing license" (deny); require a positive setup marker rather than absence-of-row.
Impact: License, security, API.
Tests: active tenant with license row removed → gated modules return 403; genuine setup flow still passes.
PASS: no un-gated access for a provisioned tenant lacking a license.
Regression: first-run activation still works.
P1-13 — Consolidate the two device systems
Evidence: device_registrations (license-bound, capped) vs sync_devices (sync-bound, effectively uncapped); no link. REMEDIATION_LOG.md:49 REMEDIATION_LOG.md:113-114
Status: SOURCE IMPLEMENTED / RUNTIME UNVERIFIED. Added nullable sync_devices.device_registration_id, a tenant-safe FK, deterministic migration backfill, and registration-time fingerprint linking. Live N+1 race/cap proof still requires PostgreSQL and a two-device harness.
Root cause: licensing and sync built device concepts independently.
Dependents: device caps, seat-race enforcement, fingerprint (P0-1).
Cascading: device cap enforced only app-level on license devices; sync devices bypass caps; same machine can appear twice.
Fix architecture: introduce a single canonical device identity (keyed by the canonical fingerprint from P0-1), link sync_devices to device_registrations, enforce max_devices against the unified set with a race-safe (unique-index-backed) check.
Impact: License, Sync, DB, security.
Tests: register N+1 devices → the N+1th blocked regardless of path; same machine registered via both paths → one canonical device.
PASS: device cap holds across both registration paths; no duplicate identity for one machine.
Regression: existing devices mapped without double-counting.
P2 — QUALITY / HARDENING
P2-1 — Frontend profitCalc.ts is a competing, unrounded COGS definition
Evidence: uses live roll-price lookup and no round2dp, unlike the authoritative backend snapshot path. profitCalc.ts:9-19 Backend COGS uses costPerKg snapshot + round2dp. PostgresInvoiceRepository.ts:289-309
Root cause: legacy client-side calc predating server-computed profit.
Fix: delete/deprecate profitCalc.ts COGS; consume the server-computed profit contract only. profit.ts:6-10
Consolidate/remove: remove the client COGS function and its call sites.
Impact: FE.
Tests: profit page renders solely from API values; no client recomputation.
PASS: grep shows no client-side COGS math; UI equals server figures to the cent.
Regression: profit display unchanged for existing data.
P2-2 — "Invariant" tests assert on source text, not behavior
Evidence: regex on source (MATERIALIZE.includes("...(createInput as X)"), createInvoiceUseCase[\s\S]{0,400}exchangeRate). sync-invariants.test.ts:972-989 API E2E accepts a wide status band. verify-fixes-api.mjs:78-80
Root cause: shape-checks used as behavior proofs.
Fix: replace source-regex assertions with runtime replay tests that assert DB state; tighten E2E to exact expected status + body.
Impact: Tests/CI.
Tests: mutate implementation while keeping the string → new test must fail.
PASS: each invariant test fails when the actual behavior regresses, not just the text.
Regression: CI still green on correct code.
P2-3 — POST /api/orders returns stale status
Evidence: response status="open" while persisted state is available/partially_available (DTO not re-read after in-tx upgrade). TASK-open-items.md:72-80
Root cause: DTO built before applyOrderAvailabilityAtCreation.
Fix: re-read the order after availability application and return the final status.
Impact: API, FE.
Tests: create order with matching stock → response status equals DB status.
PASS: creation response matches persisted status.
Regression: detail refetch still correct.
P2-4 — Cold-boot ~116s (postgres readiness dominates)
Evidence: measured 55s postgres-ready on fresh template; ~116s total cold. ENGINEERING-AUDIT.md:65-73
Root cause: fresh template copy + AV scanning + serialized boot stages.
Fix: pre-warmed template, parallelize independent boot stages, AV-exclusion guidance in installer, faster readiness probe.
Impact: Desktop UX.
Tests: measure cold boot on an AV-active client baseline before/after.
PASS: documented, reproducible cold-boot reduction with a target threshold.
Regression: boot correctness/preflight unaffected. desktop_runtime.rs:510-532
P2-5 — Bundled PostgreSQL uses --auth=trust
Evidence: initdb --auth=trust. desktop_runtime.rs:423-432
Status: SOURCE IMPLEMENTED / PACKAGED WINDOWS UNVERIFIED. Fresh initdb now uses scram-sha-256 and a DPAPI-persisted URL-safe password; copied templates perform a one-time ALTER ROLE bootstrap, rewrite pg_hba.conf, reload, and inject PGPASSWORD/DATABASE_URL. Local packaged psql/backend proof still requires a Windows resource build.
Root cause: single-device convenience; any local process can connect as superuser.
Fix: use scram-sha-256 with a DPAPI-stored password injected into DATABASE_URL; bind to 127.0.0.1 only.
Impact: Security, Desktop.
Tests: local psql without the secret is rejected; backend still connects.
PASS: no trust auth; only the secret-bearing backend connects.
Regression: boot + migrations still succeed.
P2-6 — Signed license token unencrypted in bundled pgdata (install window)
Evidence: documented low-risk (inert without DPAPI, no private key). LICENSE-ACTIVATION-PLAN.md:117-120
Status: NOT CLAIMED FIXED. The checked-in template payload is binary PostgreSQL data and has not been safely re-baked or proven free of token material; this remains packaging/build dependent. No plaintext token was found by source-path search.
Root cause: baked token stored in plaintext in the template.
Fix: encrypt or defer token materialization until after first-boot DPAPI is available.
Impact: Security, License.
Tests: inspect fresh install → no plaintext offline token before first boot.
PASS: token not readable pre-boot.
Regression: activation/verify still works.
P3 — CLEANUP / CONSOLIDATION
P3-1 — Two numbering paths (document_sequences global vs document_number_blocks per-device)
Evidence/Root cause: legacy global sequence coexists with per-device blocks. REMEDIATION_LOG.md:49
Fix: per-device blocks are canonical for provisioned synced entities; the global sequence is retained only for reconciliation/floor tracking, previews, and the explicitly opted-in transitional master-data fallback. Financial document allocation fails when no block exists.
Changes: clarified the allocator contract in `documentNumbers.ts` and the operator runbook. Full retirement awaits provisioning all entity types.
Impact: Sync, DB.
Verification: static contract tests cover the canonical path and explicit fallback boundary. Runtime collision proof requires the two-device harness and is not claimed here.
P3-2 — Two idempotency layers (HTTP 5-min vs sync durable op_id)
Evidence/Root cause: distinct mechanisms. REMEDIATION_LOG.md:49
Fix: keep both scopes and document them explicitly: HTTP method/path/tenant response replay is temporary (5 minutes); sync `(tenant_id, op_id)` uniqueness is durable and independent.
Changes: middleware contract comment and `docs/SYNC-OPERATIONS.md` boundary section; static tests assert both contracts.
Impact: API, Sync.
Verification: static contract tests only; no live Redis/Postgres concurrency proof is claimed here.
P3-3 — Audit/plan markdown proliferation and stale "FIXED/PASS" claims
Evidence: many overlapping audit docs (REMEDIATION_LOG.md, SYNC-*, LICENSE-ACTIVATION-PLAN.md); at least one (fingerprint comment) contradicts code. main.rs:222-223
Fix: this remediation plan remains the tracking document; operational details live in `docs/SYNC-OPERATIONS.md`; historical audit documents are not treated as current PASS evidence. Contradicting numbering/idempotency comments were corrected.
Impact: Docs.
Verification: static documentation/code-comment tests; no runtime PASS claim.
Global regression gate (run after every item)
Full backend integration suite against a real desktop-shaped DB (e.g. cross-currency COGS ledger assertions). audit-findings.test.ts:146-168
Two-device sync harness: offline → reconnect → duplicate → conflict → converge for every synced entity.
Cold + warm desktop boot to a green /api/health/live and SSR health.
RLS isolation probe: no-tenant checkout returns zero rows (never 22P02) on sync_tombstones/sync_conflicts. 20260914_sync_rls_canonical_policies.sql:6-30
Note: I could not verify the gitignored ~506MB desktop/src-tauri/resources/ payload, so packaging/reproducibility items (P1-9, P2-4/5/6) will need filesystem/build access to fully validate. REMEDIATION_LOG.md:54