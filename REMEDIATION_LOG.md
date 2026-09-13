Executive Summary
Motard Fabrics ERP is today a single-machine, single-tenant-at-runtime, online-to-localhost Desktop product that is functionally complete for local accounting work, with a reusable business core (invoices/ledger/stock/FX-frozen/returns/vouchers/orders/print/reports), but not an offline-first multi-device cloud product.
Critical factual deltas vs. prior docs (PROJECT-STATE-REPORT.md, OFFLINE-SYNC-GAP-ANALYSIS.md — both now partially stale):
A server-side sync prototype (Phases 3-6 partial) exists ONLY in working tree, NOT committed: 0047-0051_sync_*.sql + backend/src/application/use-cases/sync/* + backend/src/domain/sync/* + sync.route.ts + 6 Drizzle sync schemas are all ?? untracked. CODE git status §Provenance.
There is still no client-side offline store: zero IndexedDB/localforage/op-SQLite/queue/worker in src/. What exists is connectivity detection + headers + server outbox, not a local DB. CODE src/presentation/hooks/useConnectivity.ts:1-67, src/infrastructure/http/interceptors.ts:75-100.
Uninstall = data destruction by design (test phase): wix-cleanup.wxs deletes %LOCALAPPDATA%\motard-erp on REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE. Upgrade preserves DB; true uninstall wipes live pgdata+secrets+binding. CODE desktop/src-tauri/wix-cleanup.wxs:29-38, DOC desktop/BUILD-WINDOWS.md:85-101.
No updater / differential / signature / manifest / rollback: Cargo.toml has no tauri-plugin-updater, tauri.conf.json has no plugins.updater. Every MSI re-ships ~507MB resources + 38k files (~1h WiX light). CODE desktop/src-tauri/Cargo.toml:13-31, desktop/src-tauri/tauri.conf.json:47-66, DOC desktop/DEV-WORKFLOW.md:1-6, desktop/ENGINEERING-AUDIT.md:202-203.
Sessions are long-lived bearer tokens in plain localStorage (access 30m, refresh 365d), refresh rotation exists but revocation is Redis-or-no-op, and Desktop ships without Redis. Logout is client-clear + best-effort server denylist. CODE backend/src/infrastructure/config/env.ts:21-24, src/infrastructure/auth/TokenProvider.ts:1-107, backend/src/infrastructure/auth/TokenDenylist.ts:19-27.
Autostart is force-enabled every launch (plugin + defensive HKCU...Run/MotardFabricsErp rewrite) — product decision, not opt-in. CODE desktop/src-tauri/src/main.rs:13-38,71-84.
The correct verdict on the evidence is C. New product built on reusable business core — not A (small mod), not B alone (migration). Business logic is sound; offline store, sync transport Hardening, identity/session, safe updater, incremental releases, and cloud ops must be built (much already prototyped but uncommitted/unproven).
2. Current Architecture
Actual dependency chain (verified static trace):
Windows EXE (motard-fabrics-erp.exe, windows_subsystem=windows)
 -> main.rs: ensure_device_binding() [DPAPI device-binding.dat gate, refuse boot=exit(2)]
 -> tauri::Builder + tauri-plugin-autostart + HKCU Run rewrite
 -> boot_desktop_stack(cfg) [desktop_runtime.rs]
     ├ find_free_db_port(5432) [127.0.0.1 TCP probe]
     ├ preflight_check() [stat postgres/node/ssr files]
     ├ ensure_pgdata() [copy pgdata-template -> %LOCALAPPDATA%/motard-erp/pgdata if missing]
     ├ sync_pg_conf_port() [rewrite postgresql.conf port line]
     ├ start_postgres() [HiddenChild pg_ctl.exe/postgres.exe, 127.0.0.1 only]
     ├ secret_store::load_or_generate() [DPAPI secrets.dat: JWT_SECRET+APP_MASTER_KEY]
     ├ spawn_backend() [HiddenChild node.exe backend/dist/.../server.js :8080 + env]
     ├ wait /api/health/live (300ms poll, 60s timeout)
     ├ spawn_ssr() [node.exe ssr/serve.mjs :4173]
     └ wait SSR / (300ms poll)
 -> Tauri windows: splash.html (instant) + main http://127.0.0.1:4173
 -> Frontend (React19+TanStack Start SSR) -> BaseHttpClient (+Idempotency-Key, +X-Sync-Device-Id, +X-Offline-Mode)
 -> Backend Express (:8080): helmet/cors/rateLimit/requestId/json/installGate/licenseHeartbeat/auth/licenseGuard/offlineWriteGuard/routes
 -> TenantScopedPool (AsyncLocalStorage tenantContext -> SET app.current_tenant_id per checkout)
 -> PostgreSQL (bundled, local) + optional Redis (absent on Desktop)
 -> On ExitRequested: kill backend+ssr+pg_ctl stop -m fast -w, exit(0)
CODE desktop/src-tauri/src/main.rs:40-110, desktop/src-tauri/src/desktop_runtime.rs:1-17,62-330+, desktop/src-tauri/src/lib.rs:15-22, desktop/src-tauri/src/secret_store.rs:96-117, desktop/src-tauri/src/device_binding.rs:40-66, backend/src/presentation/server.ts:60-240, backend/src/infrastructure/orm/drizzle.ts:20-71, backend/src/infrastructure/orm/tenant-context.ts:1-50
Layer	Location	Responsibility (actual)
Frontend UI + thin use-cases	src/routes/*, src/components/*, src/application/use-cases/*, src/infrastructure/repositories/api/*	Forms/print/reports, API calls, no local DB
Shared contracts	src/contracts/*, packages/shared/*	Zod/DTO, FX math (@erp/shared)
Backend domain/application	backend/src/domain/*, backend/src/application/use-cases/*	Entities, ledger rules, invoice/voucher/return/order/expense/party/inventory use-cases, new uncommitted sync use-cases
Backend infrastructure	backend/src/infrastructure/*	Express routes, Drizzle repos, RLS pool, JWT, idempotency, FX widget, license, backup ZIP
Desktop shell	desktop/src-tauri/src/*.rs	Provisioning, process supervision, DPAPI, autostart, archive folders
Bundled runtime	desktop/src-tauri/resources/ (gitignored, [FS] present, 506MB)	postgres/, pgdata-template/, node.exe, backend/dist+node_modules, ssr/dist, license-public.pem
Licensing	SelfHostedLicenseProvider.ts, bake-desktop-license.ts, license.table.ts, device-registration.table.ts	Baked ~100y verify-only + dynamic activations, max_devices app-level
Auth/session	JwtSigner.ts, auth.route.ts, TokenProvider.ts, useAuth.ts	HS256 access+refresh, PIN roster, localStorage
Printing/archive	print.route.ts, document_archive.rs, documentArchive.ts	Server print jobs + Desktop Desktop/أقمشة ومنسوجات/{4 folders} PDF-via-Edge/Chrome else HTML
Business vs infra vs desktop vs cloud-ready:
Business logic lives correctly in backend/src/domain + application/use-cases/{invoices,vouchers,returns,orders,expenses,parties,inventory,ledger,profit} and is reusable. CODE PostgresInvoiceRepository.ts:1-30, invoiceUseCases.ts:119+
Infrastructure mixed into repos/route (doc-number allocation inside invoice repo tx, ledger legs built in repo, stock movements in repo) — not pure Clean Architecture (see §16).
Desktop-specific logic isolated in desktop_runtime.rs + secret_store.rs + device_binding.rs + hidden_process.rs — good. Single source app_data_dir() in lib.rs:15-22 — good.
Cloud-ready: Dockerfile, docker-compose.production.yml (PG16+Redis+nginx TLS stub), CENTRAL_SYNC_URL, deploy/nginx/default.conf exist but no managed backing services, no CD deploy, CI is typecheck/test/lint only. CODE backend/Dockerfile:1-17, backend/docker-compose.production.yml:1-74, .github/workflows/ci.yml:1-52
Duplicated responsibilities: two device systems (device_registrations license-bound vs sync_devices sync-bound), two numbering paths (document_sequences global vs document_number_blocks per-device), two idempotency layers (HTTP idempotency_keys 5-min vs sync op_id durable), two RLS bootstraps (migrations + ensureDesktopSchema() raw SQL in server.ts:350-515).
3. Current Desktop Reality
Provenance & state (working tree, main):
Branch main, HEAD 5c999c3 feat(license): make baked desktop device cap configurable, origin/main: ahead 24. Prior commit c515502 saved Rust/Tauri files that were previously untracked. CODE git log --oneline -20, git branch -vv
git status --porcelain: ~241 files changed, massive WIP (FX/multi-currency, licensing, RLS, settings, reports, routes) + deletions of ~14 debug scripts + modifications across backend/scripts/*, dist/* ignored but present, test-results/* present. Full stat truncated but counted. CODE git diff --stat: 241 files, +8167/-7373
Desktop layer: now committed (main.rs, desktop_runtime.rs, device_binding.rs, secret_store.rs, hidden_process.rs, lib.rs, bin/*_probe.rs tracked as of c515502), BUT desktop/src-tauri/resources/ is gitignored and disk-only (resources/postgres, node.exe, backend, ssr, node_modules), target/ gitignored, Cargo.lock gitignored, gen/ gitignored. CODE .gitignore: desktop/src-tauri/resources/, target/, Cargo.lock, gen/, FS desktop/src-tauri/resources size 506,692,665 bytes, pgdata-template + postgres/bin+share + backend/node_modules + ssr/dist enumerated.
Sync layer: working-tree-only, zero git history — backend/src/application/use-cases/sync/ (5 files), backend/src/domain/sync/offlineWritePolicy.ts, backend/src/presentation/routes/sync.route.ts, migrations 0047-0051, schemas sync-*.table.ts + document-number-block.table.ts all ?? untracked; git log -- .../sync empty; _journal.json modified uncommitted to add 0047-0051 (plus 0039/0043-0046). CODE git status --porcelain -- <sync paths> + _journal.json:47-51
Untracked docs of value: desktop/*.md (D4 seeding, DEV-WORKFLOW, ENGINEERING-AUDIT, FIX-PLAN, LICENSE-ACTIVATION-PLAN), docs/OFFLINE-SYNC-GAP-ANALYSIS.md, docs/PROJECT-STATE-REPORT.md, SESSION-AND-LICENSE-PLAN.md, backup/, install_*.log (118MB), desktop/*.log. CODE git status ?? list.
Backend files: 313 files under backend/src. Migrations on disk: 0001-0046 + 0047-0051 (note missing 0046 in journal? 0046 file exists user_pin_hash, journal jumps 0045->0047 — journal/file skew, see §8). FS Get-ChildItem backend/src -Recurse -File Count=313, migration list.
Verdict: Desktop shell is committed; Desktop payload (resources) is intentionally untracked build input; Sync engine is prototype in working tree only — a git clean -fd or fresh clone loses sync + resources payload. P0 provenance risk.
4. Offline Readiness
Element	STATUS	Evidence
Local database (IndexedDB/SQLite/op-SQL)	❌ MISSING	No indexedDB/idb/localforage/openDB/Dexie/sqlite in src/; prior gap doc confirms zero hits. Only localStorage for tokens/license/sync flags. [CODE] TokenProvider.ts:3-4, license-state.ts:6-9, interceptors.ts:64-100, [DOC] OFFLINE-SYNC-GAP-ANALYSIS.md §1.1
Local cache (React Query only)	🟡 PARTIAL	useCurrentUser staleTime 60s + retry, module prime caches; no persistent offline cache. [CODE] useAuth.ts:32-52
Outbox	🟡 PARTIAL (server-side only, uncommitted)	sync_outbox(tenant_id,op_id unique, entity_type/id, operation, payload jsonb, status pending/pushing/synced/rejected) + PostgresSyncOutboxRepository.enqueue/listPending/mark* + enqueueSyncUnit/enqueueVoucherCreate/... gated by isSyncEnqueueEnabled()=DESKTOP_DEPLOY||CENTRAL_SYNC_URL. No client queue. [CODE] 0048_sync_outbox_inbox.sql:1-31, sync-outbox.table.ts:19-43, PostgresSyncOutboxRepository.ts:32-68, syncEnqueue.ts:12-14
Inbox	🟡 PARTIAL (hub-side only)	sync_inbox(... status received/applied/rejected + reject_reason/conflict_op_id/conflict_detail 0050); pull writes inbox then materializes. [CODE] 0048:33-61, 0050:32-35, syncUseCases.ts:275-450
Sync queue worker / retry / scheduler	❌ MISSING	No background worker, no interval, no retry backoff; POST /sync/run manual + POST /sync/push manual; pull best-effort inside /run. [CODE] sync.route.ts:62-134
Operation IDs	🟡 PARTIAL	op_id uuid unique per tenant in outbox/inbox; Idempotency-Key header reused as opId (opIdFromRequest), else randomUUID(). No client-generated stable IDs offline (no client store to generate). [CODE] syncEnqueue.ts:27-38, syncUseCases.ts:39-42
Idempotency	✅ PRESENT (request scope, not sync scope)	Idempotency-Key per mutating request (BaseHttpClient.ts:65-79), server tryClaim Redis SET NX EX 300s else idempotency_keys DB upsert, readCached/writeCached. 5-min TTL only — not a sync engine. [CODE] idempotency.middleware.ts:41-167, 0014_idempotency_keys.sql
Retry (HTTP)	✅ PRESENT	BaseHttpClient maxRetries 2, base 300ms max 5s, timeout 15s. [CODE] BaseHttpClient.ts:11,56-100
Ordering (global)	❌ MISSING	No Lamport/clock/seq; created_at defaultNow() server time + version int per-row; sync_state.last_pull_at only. Arrival order = claimed_at on hub. [CODE] 0051_sync_state.sql, invoice.table.ts:57-60
Versioning / optimistic lock	🟡 PARTIAL	version int default 1 on invoice/order/party/return/roll/voucher; enforced only on rolls (decrement/increment ... WHERE version=expectedVersion, update optional guard). Others blind. [CODE] PostgresRollRepository.ts:165-254
Server reconciliation / apply	🟡 PARTIAL (prototype)	runLocalSyncPush (hub POST /sync/push batch ≤50, mark synced/rejected) + runLocalSyncPull (GET /sync/pull?since, materializeSyncUnit replays create/update/cancel via real use-cases with preAllocatedId + dependency snapshots). No DELETE handling, no tombstones. [CODE] syncUseCases.ts:86-280+ , syncMaterialize.ts:1-532
Conflict detection/resolution	🟡 PARTIAL (FWW prototype)	sync_resource_claims UNIQUE(tenant,resource_type,resource_id) arrival-wins; loser rejected + notification SYNC_CONFLICT. See §6. [CODE] 0050_sync_resource_claims.sql, syncUseCases.ts:~500-604
Tombstones / deletes	❌ MISSING	No deleted_at/tombstone; deletes are hard (rolls.delete tx + cleanup) or status=cancelled. Pull cannot propagate deletes. [CODE] PostgresRollRepository.ts:284-293
Change feed / sync cursor	🟡 PARTIAL	sync_state(tenant_id PK, last_pull_at) + GET /sync/pull?since&limit ordered by received_at,id; setLastPullAt only on success. No per-device cursor, no vector. [CODE] 0051_sync_state.sql, sync-device.table.ts, syncUseCases.ts:631-652
Last sync state (client)	🟡 PARTIAL	GET /sync/status {pendingCount,hubConfigured,hubUrl,lastPullAt} + GET /sync/pending (100). No persistent client watermark (no client DB). [CODE] sync.route.ts:39-59, syncUseCases.ts:66-84
Offline detection	✅ PRESENT (indicator only)	useConnectivity (navigator.onLine + GET /api/health/live 4s, 15s poll) + X-Offline-Mode header + offlineWriteGuard (warehouse/viewer blocked offline, admin/accountant allowed). Does not queue writes. [CODE] useConnectivity.ts:1-67, interceptors.ts:75-100, offline-write.middleware.ts:1-29, offlineWritePolicy.ts:8-10
Offline numbering	🟡 PARTIAL (server blocks, uncommitted)	document_number_blocks(device,year,prefix,start/end/next) + ensureDeviceNumberBlocks (local claim or hub proxy) + allocateDocumentNumber block-first else global atomic upsert. Frontend registerCurrentSyncDevice best-effort ensure after login. [CODE] 0049_document_number_blocks.sql, documentNumbers.ts:44-479, numberBlockUseCases.ts:50-144, sync-device.ts:47-60
Do not confuse idempotency.middleware (5-min duplicate-POST guard) with a Sync Engine — it has no outbox, no ordering, no conflict rules, no offline durability. The new sync_* prototype is a real step but remains hub-centric, uncommitted, and without a device-local durable queue.
5. Sync Readiness
Current (working-tree prototype) flow:
Login -> registerCurrentSyncDevice() [POST /api/auth/sync-device fingerprint->sync_devices.id -> localStorage erp.sync.deviceId]
      -> POST /sync/number-blocks/ensure (best-effort)
Write (online, DESKTOP_DEPLOY): create use-case commits locally AND enqueueSyncUnit(outbox, opId from Idempotency-Key or uuid, payload{createInput,dependencies,preAllocated:true,actor...})
Manual: POST /sync/run = runLocalSyncPush (POST hub /sync/push units[<=50]) + runLocalSyncPull (GET hub /sync/pull?since=lastPullAt) + ensureDeviceNumberBlocks
Hub POST /sync/push: for each unit: payload validation -> claimResourcesInTx (INSERT sync_resource_claims, ON CONFLICT DO NOTHING) -> if all claimed: insert sync_inbox received + materializeSyncUnit (replay use-case) -> applied / already_applied / failed; else rejected + notification to winner?? actually to loser actor (requestedByUserId) kind SYNC_CONFLICT
Pull: GET /sync/pull returns inbox applied rows since cursor (exclude own deviceId), client materializeSyncUnit each, update lastPullAt=max(received_at)
CODE sync.route.ts:62-230, syncUseCases.ts:86-280,275-560, syncMaterialize.ts:89-532, syncDependencySnapshots.ts:95-528
Gaps blocking product sync:
No transport when CENTRAL_SYNC_URL empty: runLocalSyncPush returns {skipped, reason:HUB_NOT_CONFIGURED}, pull returns zeros. Desktop default is local-only. CODE syncUseCases.ts:105-113
Hub must be reachable with same JWT (Authorization forwarded); no separate sync credential, no offline-capable auth. Pull/push fail closed without network — correct but means offline writes today still require the local backend running (Desktop localhost), not true device-independent offline.
No ordering guarantee beyond hub arrival; concurrent pushes race on sync_resource_claims; no idempotent replay across hub restarts beyond uq_sync_inbox_tenant_op.
sync_state is per-tenant, not per-device — two devices share one lastPullAt; slow device can advance cursor past rows the other hasn't seen. P1 correctness bug in prototype.
Backup excludes sync_* tables — queue lost on restore. CODE backup.route.ts:113-146 (no sync tables listed).
ensureDesktopSchema() in server.ts creates sync tables via raw CREATE TABLE IF NOT EXISTS without RLS/FORCE/policies/checks — diverges from 0047-0051 (which add RLS+FORCE). Fresh Desktop DB gets unhardened sync tables until migrations run. CODE server.ts:350-515 vs 0047-0051.
6. Conflict Resolution Readiness
No LWW anywhere in sync path — verified. Rule is First-Writer-Wins (FWW) by hub arrival (claimed_at), loser rejected whole-unit with Arabic message + notification. CODE sync-resource-claim.table.ts:13-15, syncUseCases.ts buildConflictMessage:606-629
Entity classification (current schema + recommended sync direction, no implementation):
Data	Current type	Sync strategy recommendation
fabrics, colors (master)	CRUD entity, no version guard	Content-hash + snapshot upsert (ensureInvoiceSyncDependencies already does id-based insert-if-missing); need natural-key conflict rule (name/code collision across devices) — currently throw on party natural-key conflict. [CODE] syncDependencySnapshots.ts:440-528
parties (master + balances derived)	CRUD + derived balances	Snapshot id-preserving insert; balances must never sync — recompute from ledger on each node. Opening balances excluded already (openingBalance:0).
rolls (stock, version-guarded)	Mutable entity + stock_movements events	FWW per-roll via sync_resource_claims(resource_type:invoice_roll/return_roll); current claim granularity is per-roll-id — correct direction. Need quantity-aware merge rule (oversell → reject later whole invoice, not partial).
invoices sale/entry, returns, vouchers (receipt/payment), expenses, orders	Immutable transactions (cancel via reversal, not edit; update exists but should be restricted in sync)	Atomic unit (doc + ledger legs + stock movements + linked vouchers) all-or-nothing; FWW on (number unique + resource claims); loser rejected whole. materialize* already replays via use-cases — keep.
ledger_entries, stock_movements	Derived projections (append-only)	Never sync directly; regenerate by replaying the business unit. Current code does this correctly (no ledger/stock sync path). [CODE] syncMaterialize.ts replays use-cases, not raw inserts
document_sequences / document_number_blocks	Coordination state	Keep Option-B blocks (final numbers at issue, never rewritten). Need block exhaustion + reclaim + year-rollover policy (reclaim exists). [CODE] numberBlockUseCases.ts:39-43
exchangeRate/base* (frozen FX)	Immutable snapshot per doc	Sync as part of unit payload verbatim; never recompute on replay. Current createInput passthrough does this. Must add explicit test that replay preserves exchangeRate.
orders (informational reservation, Bug-07: no hard roll lock)	Event + notification	FWW per order id; availability conflicts surface as notification, not block. Consistent with current notifyOrderAvailability.
print_jobs, notifications, audit_logs, settings, company_profiles, cashbox_*, attachments	Local/derived/operational	Do not sync in Phase 1 (print/archive local; audit local; settings need separate versioned sync later). Currently unsynced — correct.
Deletes/cancels	State transition, not tombstone	cancel* units (invoice_cancel, return_cancel, order_cancel, expense_cancel) exist and replay cancel*UseCase — correct; hard deletes must be banned in sync scope. [CODE] syncEnqueue.ts:95-303, syncMaterialize.ts:400-493
Missing for product: deterministic cross-device clock (arrival order depends on hub ingress, acceptable if documented as authority), partial-accept prohibition (already whole-unit), human remediation UX (notification exists, no resubmit flow), schema-version gate (none — v1 7-day drift unhandled, see §Data Scenarios C).
7. Multi-device Readiness
Capability	STATUS	Evidence
Same account multi-device	🟡 PARTIAL	JWTs are not device-bound; two devices can hold valid tokens simultaneously. sync_devices tracks fingerprint+lastSeen, but auth does not check it. [CODE] JwtSigner.ts:15-32, sync-device.table.ts
Simultaneous sessions	✅ PRESENT (unlimited)	No session table, no concurrency limit; only license max_devices caps device_registrations app-level, not sync_devices. [CODE] SelfHostedLicenseProvider.ts:…, device-registration.table.ts:13-16
Device registration	🟡 PARTIAL (dual systems)	(a) License devices: device_registrations(license_id,device_id,fingerprint,revokedAt) + listDevices/revokeDevice + admin UI; (b) Sync devices: sync_devices(tenant,fingerprint unique,lastSeen) + POST /api/auth/sync-device registerOrTouch + localStorage erp.sync.deviceId. No link between (a) and (b). [CODE] auth.route.ts:321-357, sync-device.ts:15-63
Device limit enforcement	🟡 PARTIAL	License max_devices enforced on activation path; sync devices unlimited. Baked desktop cap now configurable per customer (HEAD commit) but not verified here. [CODE] bake-desktop-license.ts (per log name-only)
Device revoke / force logout	🟡 PARTIAL	License device revoke sets revokedAt + audit, but no token kill: JWTs remain valid until expiry/denylist; no per-device session to destroy; no forceLogout endpoint. [CODE] SelfHostedLicenseProvider.ts:316-341
Last seen	✅ PRESENT	sync_devices.last_seen_at + last_seen_by_user_id, device_registrations.lastSeenAt. [CODE] schemas
Per-device session state	❌ MISSING	No session table; jti random per token, denylist keyed by jti only.
Server-side session state	❌ MISSING	Stateless JWT; only denylist in Redis.
Refresh rotation / reuse detection	🟡 PARTIAL	Refresh verifies, checks denylist, mints new pair with new jtis, denylists old jti. No reuse-detection alarm (old refresh reuse just fails). [CODE] auth.route.ts:160-194
Revocation (denylist)	🟡 PARTIAL (Redis-or-no-op)	RedisTokenDenylist add/has/delete return silently without Redis; Desktop has no Redis → logout does not kill tokens server-side. [CODE] TokenDenylist.ts:4,19-27, env.ts:103-105
RBAC	✅ PRESENT	rbac(allowedRoles) 401/403, 4 roles, server-enforced. [CODE] rbac.middleware.ts:4-23
RLS	🟡 PARTIAL (code present, runtime NOT VERIFIED here)	TenantScopedPool + tenant-context.ts + enable-rls.sql (3 categories, NULLIF guard) + per-migration policies + FORCE in 0047-0051. Prior live audits claim 39/39 enforced; this session performed no live SQL, so NOT VERIFIED now. 0029_rls_hardening.sql in working tree is older/known-bad (::uuid without NULLIF) vs enable-rls.sql. [CODE] drizzle.ts, rls/enable-rls.sql:1-163, 0029_rls_hardening.sql:42-54
Scenario: A offline creates sale (rolls R1,R2), B offline creates receipt/payment/stock action on same rolls, A reconnects first then B:
Today (committed, no hub): impossible — each Desktop is isolated localhost; no channel exists. Both commits succeed locally and diverge forever. Loss/divergence guaranteed on any future merge.
With working-tree prototype + hub: A's push claims (invoice_roll,R1),(invoice_roll,R2) first → applied + inbox. B's push arrives second, claimResourcesInTx hits ON CONFLICT DO NOTHING → missing claims → whole unit rejected (reject_reason + conflict_op_id + conflict_detail) + sync_inbox row + notification to B's actor SYNC_CONFLICT (“أول واصل يفوز”). B's local DB still holds its un-merged write (outbox marked rejected, local business rows not auto-rolled back — operator must fix manually). No operation ID ordering beyond arrival, no base-version check, no quantity merge. Exactly what's missing: per-device cursor, local rollback/compensation UX, base-version (expectedVersion) in claim key, resubmit flow. CODE syncUseCases.ts:~380-560,606-629
8. Database / Data Persistence
Engine: PostgreSQL (dev/ Desktop bundled; postgres:16-alpine in prod compose; local dev reported PG17 — PG16/17 skew noted in prior audit, NOT VERIFIED here). DB name erp (Desktop DB_NAME=erp, DB_SUPERUSER=postgres). CODE desktop_runtime.rs:32-33, docker-compose.production.yml:3-15
Local DB location: %LOCALAPPDATA%\motard-erp\pgdata (live) copied from resources/postgres/pgdata-template on first boot only (ensure_pgdata: if PG_VERSION+postgresql.conf exist → reuse). Secrets/binding alongside: secrets.dat, device-binding.dat, db-port.txt. Binaries in Program Files\Motard Fabrics Group ERP — AppData separated from Program Files ✅. CODE desktop_runtime.rs:330-620, lib.rs:15-22
Tenant model: single tenants row (baked default slug, id 407fccfc-... baked into frontend VITE_DEFAULT_TENANT_ID), all business tables tenant_id NOT NULL + RLS. CODE build-frontend.cmd:21, tenant.table.ts
Migrations: Drizzle migrations/*.sql + meta/_journal.json (drizzle-kit). schema_migrations(version PK, appliedAt, checksum, success) table defined but no code reads/writes it in this tree (drizzle uses __drizzle_migrations). Prior live DB had 0 applied migrations (__drizzle_migrations empty) — push-based seeding instead. Journal now lists through 0051 but files 0046 present while journal skips 0046_user_pin_hash entry? Actually journal idx47=0047 — 0046 file exists on disk (??) but no journal entry for 0046 — confirmed skew: journal has 0045 then 0047. db:migrate on fresh DB will fail/misbehave (known CREATE POLICY IF NOT EXISTS invalid syntax in 0001 path per docs). NOT VERIFIED live here; static skew verified. CODE migration list + _journal.json:44-51, migration.table.ts:3-10
Desktop bootstraps schema at runtime: ensureDesktopSchema() raw-creates pin_hash, all sync_*, document_number_blocks + indexes if missing, then listens. No version check, no checksum, no backup, no transaction wrap shown, errors only logged. CODE server.ts:350-515
Seeds/templates: pgdata-template is a binary PG data dir, not a SQL seed — copying it clones whatever rows were baked (licenses, tenant, users?). Rebuilding template from dirty shutdown caused 55s WAL recovery (RT ENGINEERING-AUDIT §2-3). Template is gitignored build artifact. FS resources present, DOC ENGINEERING-AUDIT §7 item 1
Backup/restore: POST /api/backup/full (admin, tenant-scoped JSON ZIP of ~24 tables + uploads/, resolve("./uploads") — COMPANY_LOGO_DIR not injected, noted defect). Restore is backend/scripts/restore-from-backup.mjs manual, requires pre-made schema, no roles. Sync tables not in backup list. No scheduled backups. CODE backup.route.ts:1-170, DOC ENGINEERING-AUDIT §4
UNINSTALL → INSTALL NEW VERSION → START: (a) Upgrade (MSI major upgrade, UPGRADINGPRODUCTCODE set): wix-cleanup condition false → AppData kept → ensure_pgdata reuses live pgdata → DB survives, secrets survive (DPAPI same user/machine). ✅ by code. (b) True uninstall → reinstall: rmdir /s /q %LOCALAPPDATA%\motard-erp → pgdata+secrets+binding destroyed → next install copies fresh pgdata-template (old baked rows return, customer data gone), new secrets generated (old JWTs invalid, old license token undecryptable), new binding. P0 data-loss by design in test phase. (c) Downgrade: no migration-down path; old binary on new pgdata = NOT VERIFIED, likely break. (d) Path change: app_data_dir() fixed motard-erp; no migration of path. CODE wix-cleanup.wxs:29-38, BUILD-WINDOWS.md:85-101, desktop_runtime.rs ensure_pgdata
9. Safe Update Readiness
Element	STATUS	Evidence
Migration state table	🟡 PARTIAL	schema_migrations defined, unused; drizzle __drizzle_migrations is real state but historically empty; journal/file skew now. [CODE] migration.table.ts
Forward migrations runner	🟡 PARTIAL	drizzle-kit migrate wired (db:migrate), CI runs it on erp_test, but known-broken on fresh DB per prior audit; Desktop bypasses via ensureDesktopSchema. [CODE] backend/package.json:11, ci.yml:43
Atomic migration / rollback on failure	❌ MISSING	No tx wrapper shown for ensure path; no down migrations; no rollback.
Backup-before-migration	❌ MISSING	No hook.
Old-client/new-server, old-client/new-schema compat	❌ MISSING	No version negotiation; sync payloads unversioned; parseDependenciesPayload tolerant but materialize fails closed.
Updater (Tauri)	❌ MISSING	No tauri-plugin-updater, no plugins.updater. [CODE] Cargo.toml, tauri.conf.json, [DOC] BUILD-WINDOWS.md:182-200
Update manifest / version check / signature / verification / rollback / failed-update recovery / side-by-side	❌ MISSING (all)	No latest.json, no signing doc except future code-sign note; MSI major upgrade only.
Persistent AppData separation	✅ PRESENT	%LOCALAPPDATA%\motard-erp vs Program Files; upgrade preserves (condition). [CODE] lib.rs, wix-cleanup.wxs:37
10. Incremental Update / Release Readiness
Why each build takes hours (static composition, no live build here):
MSI bundles: full postgres/bin+share + pgdata-template (~180MB/6927 files per prior measure, RT ENGINEERING-AUDIT) + node.exe + backend/dist + backend/node_modules (tens of thousands files) + ssr/dist + node_modules top-level + frontend dist. Total resources ~507MB on this disk. FS size + file tree.
before-build.cmd → build-frontend.cmd: VITE_DESKTOP_DEPLOY=true, VITE_API_BASE_URL=http://127.0.0.1:8080, full npm run build, copy splash.html, robocopy /MIR dist→resources/ssr/dist, del *.map. Then cargo build --release + WiX light over ~38k files (~1h). CODE before-build.cmd, build-frontend.cmd, DOC DEV-WORKFLOW.md:55-63
No separation of concerns for updates: binaries, runtime deps, static assets, DB template, user data all in one MSI; user data correctly outside MSI at runtime (AppData) but template inside MSI means every release re-ships 180MB DB seed.
No updater/differential/patch/content-hash/versioned-asset reuse/CI artifacts: tauri-plugin-updater absent, no latest.json, no patch packages, CI builds nothing shippable. Fast path exists only for dev (dev-fast profile: opt-level=0,debug=false,incremental=true, ~1-2m after first ~7m). CODE Cargo.toml:45-55, DOC DEV-WORKFLOW.md:7-33
Reusable-without-rebuild candidates (no optimization executed): postgres/ binaries (change rarely), node.exe, pgdata-template (only when seed/schema changes), backend/node_modules (only on dep change). Per-release deltas should be backend/dist + ssr/dist + Rust exe only — requires updater/partitioned layout not present.
All STATUS ❌ MISSING except dev-fast profile 🟡 and AppData separation ✅.
11. Startup Performance
Traced stages (code-present, durations NOT VERIFIED by live run in this audit; prior numbers quoted as [RT] doc):
EXE → device_binding (DPAPI read/write device-binding.dat, mandatory every boot, fail=exit 2) → Tauri init (splash instant) → autostart re-register (reg.exe + plugin enable, every boot) → BootConfig::for_app (read license-public.pem, resolve db_port) → find_free_db_port → preflight_check → ensure_pgdata (copy template FIRST boot only; reuse after) → sync_pg_conf_port (rewrite every boot, cheap) → start_postgres (pg_ctl start + wait TCP) → createdb best-effort → secret_store load_or_generate (first boot generates, later reads) → spawn_backend node server.js :8080 (fixed port, baked at frontend build) → wait /api/health/live 60s → spawn_ssr serve.mjs :4173 (fixed, must match tauri.conf) → wait / → main window visible → license validate_license on-demand IPC only (zero boot cost). Shutdown kills children + pg_ctl stop -m fast -w. CODE main.rs:40-110+, desktop_runtime.rs (all), ENGINEERING-AUDIT §1 map
Stage	Present?	Mandatory?	Repeats every boot?	Skippable after setup?
Device binding	Yes	Yes	Yes (verify)	No (cheap, keep)
License init	No boot check (on-demand)	No	No	N/A (already optimal)
pgdata copy	Yes	First boot only	No (reuse if PG_VERSION+conf exist)	Yes (already)
pg_ctl start + TCP wait	Yes	Yes	Yes	No (required)
Backend spawn + /live wait	Yes	Yes	Yes	No, but backend ~21s Defender-bound ([RT] doc)
SSR spawn + / wait	Yes	Yes	Yes	No
Autostart rewrite	Yes	Product req	Yes	No (by decision)
RT Prior measured (same boot_desktop_stack via runtime_probe, MSI 2026-09-04): cold (dirty template, WAL recovery) ~55.2s, of which ~53s recovery; warm target after clean-template rebuild ~5-6s, first launch ~15-25s projected; backend module load 21s under Defender; install MSI itself 9m. DOC ENGINEERING-AUDIT.md §2-3,§7 — these are prior measurements, NOT re-measured in this read-only audit → treat FIRST/SECOND/AFTER-REBOOT comparison as NOT VERIFIED now.
No COMPANY_LOGO_DIR injected (backend falls back to bad Windows path — non-boot defect). DOC ENGINEERING-AUDIT §1 table.
12. Remember Me / Session
Flow (verified static):
Login (POST /api/auth/login, rate-limited 5/15m per IP+email, skipSuccessfulRequests): findUserByEmail (tenant-scoped) → Argon2 verify → mint access (30m) + refresh (365d) with fresh jtis. Desktop mode forces baked tenant. CODE auth.route.ts:90-160, env.ts:21-24
PIN login (POST /api/auth/pin-login, 0046 pin_hash + ensureDesktopSchema): device roster GET /api/auth/device-roster?tenantId= (public, allow-listed) → 4-digit PIN → same token pair. UserPickerPage is the actual login UI (/login renders it). CODE auth.route.ts:200-272, UserPickerPage.tsx:49-93, login.tsx:10-21
Persist: persistTokens() → localStorage erp.auth.accessToken/refreshToken (plain, no DPAPI/cookie/httpOnly). License key separate AES-GCM(fingerprint)+localStorage; install tenant plain. CODE TokenProvider.ts:60-68, license-state.ts:39-104,141-150
Reopen: useCurrentUser → if no access but stored session, onTokenExpired() refresh-first → GET /api/auth/me. Retry transient 4x backoff; never retry 401/403. CODE useAuth.ts:32-52, TokenProvider.ts:31-56,44-53 (Issue-18 fix: only definitive 401/403/TOKEN_EXPIRED clears storage; network/5xx keeps session)
Refresh (POST /api/auth/refresh): verify type=refresh → denylist check → user active → mint new pair → denylist old jti (rotation). No reuse alarm. CODE auth.route.ts:160-194
Logout (POST /api/auth/logout auth): denylist access jti (TTL = remaining), then client clearTokens() even on network failure; keeps erp.auth.lastEmail for password-only re-login; qc.clear(). Server kill is no-op without Redis. CODE auth.route.ts:196-214, useAuth.ts:72-91
Network loss → reopen: tokens stay; useConnectivity marks offline; refresh fails with NetworkError (not definitive) → tokens kept → UI stays “logged in” but API fails — correct, no false logout. CODE TokenProvider.ts:44-53
Expired refresh → reopen: refresh rejected definitive → storage cleared → /login roster. Correct.
Remember Me: no checkbox — behavior is always-remember (365d refresh) until explicit logout. Matches requested product behavior (§2.1 “open directly”) but is implicit, not a user control.
Device-bound? No — tokens are bearer, fingerprint only for license/sync-device, not cryptographically bound to tokens. Theft of localStorage = session theft (XSS risk noted, httpOnly migration pending per prior audit D-action).
13. Autostart
tauri-plugin-autostart v2 + launcher.enable() every setup + defensive reg.exe add HKCU\...\Run /v MotardFabricsErp /d "<current_exe>" /f every launch (Issue-19: upstream Run key vanishes after one boot). Value is quoted full EXE path. CODE main.rs:13-38,71-110, Cargo.toml:25
Always-on (no setting, no opt-out in code read). Depends on stable install path; MSI moves path → next launch re-registers new path (self-heal). No scheduled task/service. CODE main.rs:14-19
Uninstall cleanup: NOT VERIFIED — wix-cleanup.wxs only removes AppData; no evidence Run key removed (plugin should on uninstall, defensive key may linger). Flag as NOT VERIFIED.
Reliability: re-registration exists (double layer); vanishing recurrence still possible (external cleaners/AV/GPO); no telemetry to prove “works always”.
14. Cloud Readiness
Item	STATUS	Evidence
Backend standalone (no Desktop)	✅ PRESENT	Express server, HOST/PORT, health endpoints. [CODE] server.ts
Central PostgreSQL	🟡 PARTIAL	SQL + RLS + compose service, but no managed services, no prod ops, PG16 vs PG17 skew. [CODE] docker-compose.production.yml:3-15
Redis	🟡 PARTIAL	ioredis, denylist + idempotency primary, compose service; absent on Desktop, production boot requires it (non-Desktop). [CODE] TokenDenylist.ts:4, env.ts:106-114, compose :17-27
Object storage (logos/uploads)	❌ MISSING	Local ./uploads + Desktop folders; backup copies local uploads. [CODE] backup.route.ts:55-56
TLS / reverse proxy	🟡 PARTIAL	deploy/nginx/default.conf (80→443, TLS1.2/1.3, backend:8080) + cert mount expected; no cert automation, no prod deploy doc. [CODE] nginx file
Secrets management	🟡 PARTIAL	APP_MASTER_KEY + .env + DPAPI (Desktop) + auto-generate-and-append-to-.env dev fallback; no KMS/vault. [CODE] env.ts, container.ts:260-320
Cloud migrations	❌ MISSING (reliable path)	db:migrate wired but historically broken fresh; no cloud migration job.
Backups (cloud)	❌ MISSING	Tenant ZIP download only; no schedule, no offsite, no PITR.
Monitoring/alerting	🟡 PARTIAL	Sentry optional + pino + `/health/live
CI/CD	🟡 PARTIAL	CI: typecheck×2, unit, PG+Redis integration (db:migrate on erp_test + vitest), lint, knip advisory. No build/publish/deploy/release. [CODE] ci.yml
Deployment	🟡 PARTIAL	Dockerfile (multi-stage, USER node, healthcheck) + prod compose; no registry, no env provisioning, no zero-downtime.
Tenant provisioning	✅ PRESENT (local)	Setup wizard (init/status/steps/activate/complete) + assertWizardMutable + install gate. [CODE] setupUseCases.ts, install.gate.middleware.ts
Billing/subscriptions	❌ MISSING	Zero (grep stripe/billing = enum only per prior report; no contrary code found).
Licensing (current)	🟡 PARTIAL	Baked verify-only + dynamic Ed25519 tokens + heartbeat (non-blocking) + gates; suspended passes (prior finding, code path not re-read line-by-line → carry as reported). Reusable as interim, not billing.
Reusable for cloud: Express routes/use-cases/repos, RLS design, JWT/Argon2/Ed25519, idempotency, health, Dockerfile/compose/nginx skeleton, setup wizard. Must build new: managed PG/Redis/storage/TLS automation, migration job, backup regime, secrets manager, CI release pipeline, multi-device identity, sync hub hardening/ops.
15. Business Core Reusability
BUSINESS CORE REUSABLE (keep, do not rewrite): invoices sale/entry + lines + paid/method + frozen exchangeRate/baseTotal/basePaid CODE invoice.table.ts:34-54; returns + lines + contra ledger types CODE return.table.ts, ledger-entry-type.ts:8-31; vouchers receipt/payment + exchangeRate/baseAmount CODE voucher.table.ts:33-38; ledger double-entry + append-only intent (0036b_ledger_append_only, archive table) + LEDGER_ENTRY_TYPES single source; parties + yearly summaries; fabrics/colors/rolls + version + stock_movements append-only CODE stock-movement.table.ts:5-10; orders + informational reservation (Bug-07 direction); print jobs + receive cost/expense link + frozen FX CODE print-job.table.ts:38-39; cashbox sessions/movements/day-closes + day-lock (assertDayUnlocked); profit/statement/dashboard/reports; audit logs; idempotency + doc-number atomic upsert.
Critical invariants to preserve: historical FX snapshots frozen (FxRateService is display-only by governing comment, never billing — CODE FxRateService.ts:7-23); ledger integrity must not be replaced by simplified sync (replay uses real use-cases — keep).
INFRASTRUCTURE MUST CHANGE: offline store (new), sync transport/cursor/conflict hardening, per-device identity/session + Redis + force-logout + httpOnly, migration runner + backup-before-migrate + rollback, updater + differential releases + signing, cloud ops (managed PG/Redis/storage/TLS/secrets/backups/monitoring/CDN/CD), RLS runtime verification in CI, backup to include sync state, upload storage abstraction.
16. SOLID / Clean Architecture Audit (samples, not exhaustive)
#	Location [CODE]	Current responsibility	Violation	Risk	Direction (no impl)
V1	backend/src/infrastructure/di/container.ts:1-320 (god container: DB+auth+repos+license+secrets+fingerprint+keygen+.env write)	DI + keypair generation + filesystem mutation	SRP/DIP (infra constructs domain secrets; side-effect on import path)	Boot surprise, test coupling	Split composition root / key management / secret persistence
V2	backend/src/presentation/server.ts:350-515 ensureDesktopSchema() (raw DDL for 6 tables + indexes inside HTTP entrypoint)	Boot + migration + schema	SRP/OCP (schema change = edit server boot)	Drift vs 0047-0051 (no RLS), unversioned	Dedicated migration runner + version gate
V3	PostgresInvoiceRepository.ts (number allocation + invoice + lines + ledger legs + stock + vouchers + audit in one repo)	Persistence + numbering + accounting policy	SRP/Domain leak (ledger/stock policy in infra repo)	Hard to reuse safely in sync replay	Move policy to application/domain services; repo persists
V4	invoiceUseCases.ts:75-117 invoiceErrorMessage (SQLSTATE→Arabic UX strings in application layer)	Business + presentation mapping	Separation (UI text in use-case)	i18n churn, sync reuse carries UI strings	Error codes + presentation mapper
V5	backup.route.ts:112-161 (route builds raw SQL via string interpolation + esc(), table allowlist in route)	HTTP + dump policy	SRP/Security (raw SQL in presentation; fragile escaping)	Injection on table-name path if allowlist bypassed; backup omits sync tables	Repository + explicit table registry incl. sync meta
V6	auth.middleware.ts:13-31 userNameCache (global mutable Map, 5m TTL, no invalidation)	Auth + cache	SRP/staleness	Actor name drift in audit	Bounded cache with invalidation or join
V7	Dual device models (device-registration.table.ts vs sync-device.table.ts) + dual numbering (document-sequence vs document-number-block)	Two sources of device/number truth	SSOT/DRY	Desync (limit vs sync, number collision on fallback)	Unify identity; define fallback precedence
V8	src/infrastructure/container.ts (frontend mirrors backend DI with Api* repos + use-cases)	UI + application layer duplication	DRY/Clean (business rules in two trees: src/domain/entities vs backend/src/domain)	Rule drift (Invoice/Voucher entities exist in both)	Single shared domain package (packages/shared exists but underused for entities)
V9	documentNumbers.ts (block-first + global upsert + preAllocated floor-raise + preview in one module, DB-coupled)	Numbering policy + SQL	ISP/OCP	Year/prefix change ripples	Policy interface + store adapter
V10	syncUseCases.ts (push+pull+claims+notify+number-block refill + cursor in one module, 650+ lines)	Sync orchestration	SRP (prototype cohesion)	Untestable growth	Split push/pull/claim/materialize/cursor (ports already hint this)
Positive: LEDGER_ENTRY_TYPES single source CODE ledger-entry-type.ts:1-38; app_data_dir() single source CODE lib.rs:15-22; TenantScopedPool correctly stamps per-checkout CODE drizzle.ts:20-71; offlineWritePolicy.canWriteOffline isolated CODE offlineWritePolicy.ts:8-10; sync ports (ISyncOutbox/Inbox/ResourceClaim/Device/NumberBlock) show intended DIP.
17. Master Gap Matrix
Area	Current State	Evidence	Required Target	Gap	Severity
Offline (local DB/queue)	No client store; server outbox prototype uncommitted	[CODE] src/ zero IDB; 0048+repos ??	Durable device DB + queue + worker	Build new	P1
Sync (transport)	Manual push/pull to optional hub; no worker/retry/cursor-per-device	[CODE] sync.route.ts:62-134; CENTRAL_SYNC_URL optional	Auto sync + retry + per-device cursor + version gate	Harden + commit + prove	P1
Conflict Resolution	FWW arrival prototype, whole-unit reject + notify	[CODE] sync_resource_claims, buildConflictMessage	Business-aware FWW + compensation UX + base-version	UX + rules + tests	P1
Multi-device	Fingerprints tracked, auth not device-bound, unlimited sessions	[CODE] sync_devices vs JWT	Device identity + limits + revoke + force-logout	Build	P1
Sessions	30m/365d bearer localStorage; rotation yes, reuse-alarm no	[CODE] env.ts:21-24, auth.route.ts	httpOnly/secure + rotation + reuse detection + server sessions	Migrate	P0* (XSS/theft; *data-loss-adjacent security)
RBAC	4 roles enforced 403	[CODE] rbac.middleware.ts	Keep + user disable endpoint (missing)	Add disable	P1
RLS	Code complete, runtime NOT VERIFIED here; 0029 stale vs enable-rls.sql	[CODE] drizzle.ts, enable-rls.sql, 0029	Enforced + CI-proven on prod path	Verify + wire CI	P0
Database (Desktop)	Bundled PG, AppData-separated, template-reuse	[CODE] desktop_runtime.rs, lib.rs	Same + template hygiene + path migration	Process	P1
Migrations	Journal/file skew; fresh-migrate broken history; Desktop raw-DDL bypass	[CODE] _journal.json vs 0046 file; server.ts:350-515	Versioned, atomic, backup-before, CI-green fresh	Rebuild runner	P0
Updates (safe)	Upgrade keeps DB; true uninstall wipes DB by design	[CODE] wix-cleanup.wxs:37	Never wipe on uninstall; explicit factory-reset only	Gate behind opt-in	P0
Rollback (migrate/update)	None	No code found	Atomic migrate + update rollback + recovery	Build	P0
Updater	None (no plugin, no manifest)	[CODE] Cargo.toml, tauri.conf.json	Signed updater + channels	Build	P1
Incremental updates	Full 507MB MSI every time, ~1h	[FS] 506MB; [DOC] DEV-WORKFLOW	Differential/partitioned payloads	New release arch	P2
Startup	Correct staged boot; license zero-cost; prior warm ~5-6s target	[CODE] boot trace; [RT] prior probe	Fast second boot, no re-provision	Clean template + Defender guidance	P2
Remember Me	Always-remember 365d; no false logout (Issue-18 fixed); plain storage	[CODE] TokenProvider.ts	Same UX + secure storage + real logout	Secure store	P1
Autostart	Force-on dual layer every boot	[CODE] main.rs:13-84	Agreed behavior (opt-in/out) + cleanup proof	Product decision + verify uninstall	P2
Cloud	Standalone + compose skeleton; no managed backing, no CD	[CODE] Dockerfile, prod compose, ci.yml	Managed PG/Redis/storage/TLS/secrets/backups/CD	Build ops	P1
Billing	Zero	Prior grep; no contrary code	Plan or explicit no-billing	Decide	P2
Licensing	Baked verify-only + dynamic tokens + heartbeat; suspended passes (reported)	[CODE] provider + env.ts gates	Enforced states + grace policy + device cap proof	Fix + prove	P1
Device Management	Two systems, revoke without session kill	[CODE] both tables + provider	Unified + force-logout	Unify	P1
Printing	Server jobs + Desktop folder archive (Edge/Chrome→PDF else HTML)	[CODE] document_archive.rs, print-job.table.ts	Keep local; exclude from sync v1	Keep	P3
Business Core	Complete & reusable; FX frozen; ledger sound	[CODE] tables + use-cases	Freeze + guard with tests	Protect	P0 (regression risk)
SOLID	Mixed; god container, repo policy leak, dual truths	§16 samples	Incremental modularization	Refactor slices	P2
Clean Architecture	Ports exist; impl leaks (SQL in routes, UX in use-cases)	§16 V2/V4/V5	Ports + adapters discipline	Enforce	P2
CI/CD	CI checks only; no release	[CODE] ci.yml	+ migrate verify + RLS verify + releaseartifacts	Extend	P1
Monitoring	Sentry+pino+health/deep	[CODE] health.route.ts	Dashboards + alerts + log retention	Build	P2
Backups	Tenant ZIP manual; omits sync; restore manual	[CODE] backup.route.ts	Scheduled + sync-aware + tested restore + PITR	Rebuild	P0
18. P0 / P1 / P2 / P3 + Top 10 Blockers
P0 (data loss / security / corruption): uninstall wipes live DB; migration runner unreliable + journal skew + raw-DDL bypass; RLS runtime unproven here; backup omits sync + no schedule + manual restore; tokens in plain localStorage + denylist no-op without Redis; business-core regression risk.
P1 (blocks architecture/product): no client offline store/worker; sync prototype uncommitted + per-tenant cursor bug + no version gate; multi-device identity/revoke/force-logout; no updater/safe-update; no user-disable; licensing enforcement gaps; cloud ops missing; CI without RLS/migrate gates.
P2 (important, can follow): incremental releases; startup Defender/template hygiene; SOLID/modularization; monitoring/alerts; billing decision; autostart product agreement.
P3 (polish): printing refinements, icon placeholder, version-string unification (0.1.0 vs 1.0.0 per ENGINEERING-AUDIT §5), log-file hygiene (118MB install logs, backend-dev.log 1.3MB in repo).
Top 10 blockers (ordered):
 1. Uninstall destroys %LOCALAPPDATA%\motard-erp — gate behind explicit factory-reset before any real customer. CODE wix-cleanup.wxs:29-38 — P0
 2. Sync engine + migrations 0047-0051 exist only in working tree — commit-or-lose + git clean risk; journal missing 0046. — P0
 3. No device-local durable offline store/worker — online-localhost ≠ offline-first. — P1
 4. sync_state per-tenant (not per-device) cursor — slow-device data loss on pull. CODE 0051 + setLastPullAt — P0 (correctness)
 5. Logout/revocation no-op without Redis; Desktop ships Redis-less; 365d bearer in plain localStorage. — P0
 6. ensureDesktopSchema() raw DDL without RLS/policies diverges from migrations; fresh Desktop sync tables unhardened. CODE server.ts:350-515 — P0
 7. Fresh db:migrate unreliable; no backup-before-migrate, no rollback, downgrade undefined. — P0
 8. Backup excludes sync_*/blocks/cursors; restore loses queue + numbering state. CODE backup.route.ts:113-146 — P0
 9. Dual device/numbering/idempotency truths can desync (device_registrations vs sync_devices, sequences vs blocks). — P1
10. No updater/manifest/signature/differential — every release is a full ~507MB ~1h MSI; template re-shipped each time. — P1
19. Target Architecture (no code, derived from current reality)
LOCAL DEVICE (Windows)
 ├ Desktop Shell (Tauri Rust): device-binding gate, autostart, AppData root (single source)
 ├ Local DB (NEW: durable device store — SQLite/embedded PG-lite + queue tables)
 ├ Domain/Application (REUSE: invoices/ledger/stock/FX-frozen/returns/vouchers/orders/print/reports use-cases)
 ├ Outbox (COMMIT+HARDEN current sync_outbox: op_id, unit payload, deps snapshots, number-block ref, base-version)
 ├ Sync Worker (NEW: auto push/pull, retry/backoff, per-device cursor, schema-version gate)
 └ Updater (NEW: signed manifest, channels, differential payloads, rollback, factory-reset separation)
        ↕ HTTPS (JWT + device cert, Idempotency-Key + op_id)
CLOUD API (REUSE Express + RLS pool + RBAC + idempotency + health)
 ├ Sync Hub (HARDEN: /sync/push|pull|status|pending + number-blocks + FWW claims + inbox + notifications)
 ├ Conflict/Ordering Authority (hub arrival = order; resource claims UNIQUE; whole-unit accept/reject; conflict_detail)
 ├ Inbox/Change feed (per-device cursor, tombstones for cancels/deletes, version negotiation)
 ├ Central PostgreSQL (managed, PITR, RLS enforced+CI-proven) + Redis (sessions/denylist/idempotency) + Object storage (uploads/logos)
 └ Identity/Licensing/Billing (unified device registry + server sessions + rotation/reuse detection + force-logout + license/billing)
        ↕ fan-out
DEVICE B (same tenant, different city): pull since own cursor → materialize via same use-cases → local projections (ledger/stock/balances recomputed, never synced raw)
Separation: Business Domain (entities/rules, frozen FX, double-entry) / Application (use-cases, offline policy, numbering policy) / Infrastructure (PG/Redis/storage/Drizzle/Express) / Desktop (provisioning/supervision/DPAPI/autostart/archive) / Sync (outbox/inbox/claims/cursors/materialize) / Cloud (hub/ops/TLS/secrets/backups/CDN) / Identity (auth/sessions/devices) / Licensing (verify + entitlements) / Updater (manifest/signature/differential/rollback).
20. Dependency-aware Migration Roadmap (no implementation started)
Phase 0 — Protect current Desktop+Git+backups: commit/stash sync + migrations + journal fix (0046 entry), tag goldens, snapshot pgdata-template clean-shutdown rebuild, copy resources/ + backup/ off-repo, forbid git clean, add 0046 journal + verify db:migrate fresh in CI. Depends on nothing; blocks all.
Phase 1 — Data integrity + migration architecture: single runner (drizzle migrate), remove ensureDesktopSchema DDL drift (or make it version-checked + RLS-identical), backup-before-migrate, atomic + rollback, RLS CI proof (verify-rls), include sync tables in backup, fix per-tenant cursor → per-device. Depends on 0.
Phase 2 — Offline local store: device DB + durable queue + useConnectivity-driven worker (no business rewrite; reuse use-cases offline against local store interface). Depends on 1.
Phase 3 — Outbox/inbox/idempotency/versioning: commit current prototype, add op stable IDs offline, payload versioning, base-version (expectedVersion) in claims, tombstones/cancel units, per-device sync_state. Depends on 2.
Phase 4 — Cloud sync (hub): harden /sync/*, CENTRAL_SYNC_URL ops, auth for sync, arrival ordering docs, load/race tests. Depends on 3.
Phase 5 — Conflict resolution (business-aware FWW): per-resource rules (§6 table), whole-unit guarantee incl. ledger/stock atomicity, loser notification + resubmit UX, oversell/number-exhaustion policies. Depends on 4.
Phase 6 — Multi-device identity/session: unify device_registrations+sync_devices, per-device sessions, Redis mandatory in cloud + Desktop session strategy, rotation+reuse detection, revoke+force-logout, user disable, httpOnly/secure storage plan. Depends on 4 (identity needed before scale).
Phase 7 — Safe application updater: Tauri updater + signed manifest + channels + pre-update backup + migration gate + rollback + failed-update recovery + uninstall-vs-upgrade separation (remove wipe from uninstall). Depends on 1.
Phase 8 — Incremental release system: partition payload (PG/node/template rarely; dist/exe often), content hashing, CI artifacts, differential packages. Depends on 7.
Phase 9 — Cloud deployment: managed PG/Redis/storage, TLS automation, secrets manager, backups/PITR, Sentry/dashboards/alerts, CD, tenant provisioning runbook, migration job. Depends on 1,4,6.
Phase 10 — Web/Tauri clients: web client against cloud API + Desktop against hub-or-local per mode; shared domain via packages/shared. Depends on 2-9.
21. VERIFIED (this session, read-only)
Git: main ahead 24, HEAD 5c999c3, prior c515502 saved Rust shell; 241-file diff; sync 0047-0051 + sync code ?? uncommitted with empty git log for sync dir; resources/target/Cargo.lock/gen gitignored. CODE/FS
Desktop boot chain, DPAPI binding/secrets, app_data_dir single source, autostart dual layer, fixed ports 8080/4173, health waits, kill-on-exit. CODE main.rs, desktop_runtime.rs, lib.rs, secret_store.rs, device_binding.rs, hidden_process.rs
Uninstall wipe vs upgrade preserve (REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE); AppData/Program Files separation. CODE wix-cleanup.wxs, BUILD-WINDOWS.md
No updater/differential/manifest/signature; 506MB resources; full MSI via before-build+frontend+WiX; dev-fast profile. CODE/FS
Auth/session/token/PIN/roster/refresh-rotation/denylist-no-op/localStorage/Issue-18 handling/logout semantics. CODE auth.route.ts, JwtSigner.ts, TokenDenylist.ts, TokenProvider.ts, useAuth.ts, UserPickerPage.tsx
Idempotency request guard (Redis 5m + DB fallback) distinct from sync. CODE idempotency.middleware.ts, 0014, BaseHttpClient.ts
Sync prototype shape: outbox/inbox/claims/blocks/state schemas + routes + push/pull/materialize + FWW + notifications + offline guard + connectivity + device registration. All working-tree-only. CODE 0047-0051, sync*.ts, sync.route.ts, useConnectivity.ts, interceptors.ts, offline-write.middleware.ts
Journal/file skew (missing 0046 journal entry); ensureDesktopSchema raw DDL vs RLS migrations; backup table list omits sync; 0029 stale vs enable-rls.sql. CODE
Business core presence + frozen-FX display-only rule + ledger types + stock append-only + atomic numbering upsert. CODE
Cloud skeleton (Dockerfile/compose/nginx/CI/health) with no CD/managed backing/billing. CODE
22. NOT VERIFIED (no live execution in this audit — do not treat as fact)
Any runtime behavior: DB row counts/RLS enforcement/migrations applied/login/sync push-pull/conflict outcome/timing (FIRST vs SECOND vs AFTER-REBOOT durations, 55s/5s/21s figures are prior-doc, not re-measured).
CENTRAL_SYNC_URL hub E2E, multi-device A/B ordering, 7-day schema-drift, 50%-update interruption, migration-failure data safety, uninstall Registry cleanup, autostart persistence across reboot, token theft/XSS exploitability, PG16/17 runtime skew, suspended-license pass-through (carried from prior audit, not re-proven).
Anything requiring SELECT, port/process inspection, build, or install — explicitly not run per safety rules.
23. BLOCKED (cannot answer read-only/static-only)
Live performance measurements, live RLS proof, live backup/restore proof, live sync conflict proof, live update/rollback proof — all need a sanctioned non-destructive live environment + explicit permission (and for sync, committing the prototype first).
Whether baked pgdata-template on disk contains customer vs seed rows (binary dir, no live PG query performed).
Hub capacity/ordering under concurrency (no hub deployed here).
24. MUST NOT TOUCH (protect until roadmap Phase 0+)
desktop/src-tauri/resources/** (untracked 506MB payload), desktop/src-tauri/target/**, live %LOCALAPPDATA%\motard-erp\pgdata, secrets.dat, device-binding.dat
Working-tree-only sync stack (0047-0051, sync/**, sync.route.ts, sync schemas) — commit first, never git clean
bake-desktop-license.ts + license-public.pem + private signing keys + backend/.env + customer DB rows
Business core accounting correctness: ledger legs, LEDGER_ENTRY_TYPES, frozen exchangeRate/base*, stock_movements append-only, documentNumbers atomic path
WIP FX/multi-currency diff, admin-dashboard + license-server, prior tags (pre-multi-currency-v2, golden-state-*), backup/ snapshots, large *.log files (archive, don't delete in this task)
## Batch: Licensing regression fix + tombstone enforcement (2026-09-12)

### STATUS
Implementing. Licensing test failure diagnosed and fixed (pre-existing, not a sync
regression). Tombstone enforcement for deleted master data implemented and covered
by new regression tests. Full suite green except the environmental live-API suite
(`audit-findings.test.ts`, needs backend on 127.0.0.1:8080).

### REAL PROBLEMS FOUND
1. `tests/licensing-engine.test.ts` "resolves a basic plan" asserted
   `resolveFeatures("basic") === [FEATURES.INVENTORY]`, but
   `src/domain/licensing/plans.ts` (owner decision 2026-08-28, "accounting is
   core — included in every plan") returns `[feature.inventory, feature.accounting]`.
   The test was stale, not the code. Doc `VERIFICATION_RESULTS_P0.md` already
   recorded it as the known pre-existing "P1-004b". Not caused by this session's sync work.
2. **Tombstones were a table with no enforcement (plan §10).** `sync_tombstones`
   existed (migrations `0058_sync_tombstones` + `20260912_batch1_*`) and was in the
   backup dump, but NO sync code wrote or read it. Migration `0058`'s comment
   referenced a non-existent `ensureTombstoneBeforeMasterMutation` in
   `syncMaterialize.ts`. Concretely:
   - `materializeMasterMutation` (delete) hard-deleted the row and reported `created`
     without recording a tombstone.
   - `materializeMasterCreate` and `ensureInvoiceSyncDependencies` (insert-if-missing)
     could silently resurrect a deleted fabric/color/roll when a stale offline
     create or an invoice/return dependency snapshot replayed after the delete —
     the exact "resurrected deleted data" convergence failure.

### FALSE POSITIVES
- The licensing failure was NOT caused by the sync/outbox batch (absent from the
  earlier 74/74 targeted run); it is a standalone stale unit test.

### CHANGES MADE
- `backend/tests/licensing-engine.test.ts`: updated the "basic plan" assertion to the
  current frozen spec — contains inventory AND accounting, length 2 (with explanatory comment).
- `backend/src/application/use-cases/sync/syncMaterialize.ts`:
  - Added `pool` + `logger` imports and `SyncMaterializeMeta` (opId + device provenance
    taken from the INBOX row, never the wire payload — P6/SYNC-06).
  - Added `tombstoneExists` and `recordTombstone` helpers (idempotent ON CONFLICT).
  - `materializeSyncUnit` now accepts `meta`; delete branch records a tombstone and the
    idempotent `!hub` retry re-asserts it; master create is refused (`failed`) when a
    tombstone exists. No naive "create clears tombstone" rule.
- `backend/src/application/use-cases/sync/syncDependencySnapshots.ts`: added
  `syncTombstoneBlocksDependency`; all four dependency-insert loops skip tombstoned masters
  so document replays cannot resurrect them.
- `backend/src/application/use-cases/sync/syncUseCases.ts`: both `materializeSyncUnit`
  call sites pass `{ opId, syncDeviceId }` provenance.
- `backend/tests/sync-invariants.test.ts`: added 4 tombstone-enforcement regression tests.

### MIGRATIONS
- None added. `sync_tombstones` schema already present and journal-registered.

### TESTS RUN
- `npx tsc --noEmit -p tsconfig.json` → clean.
- `npx vitest run tests/sync-invariants.test.ts` → 70 passed (incl. 4 new tombstone tests).
- `npx vitest run tests/sync-invariants.test.ts tests/sync-coverage.test.ts
  tests/sync-claim-release.test.ts tests/migrations-journal-guard.test.ts
  tests/licensing-engine.test.ts` → 100 passed.
- `npx vitest run` (full) → 202 passed | 10 skipped | 1 failed (`audit-findings`,
  live-API-only, environmental).

### ACTUAL RESULTS
- Licensing "resolves a basic plan" now passes (was the 1 failing test).
- Tombstone guard wired: delete → record tombstone; create/dependency replay →
  blocked resurrection (visible `failed` → `dead`, never silent `created`).

### REGRESSION RESULTS
- Prior baseline full suite was 197 passed + 2 failed (licensing + audit-findings).
  Now 202 passed + 1 failed (only environmental audit-findings). No regressions.

### REMAINING RISKS
- `sync_conflicts` table (batch1 migration) is still unread/unwritten — the
  explicit conflict-tracking flow (update/cancel reconciliation state) is the next
  piece of this batch, not yet implemented.
- Tombstone write in `materializeMasterMutation` is not in a single wrapping
  transaction with the hard delete; a crash between them is recovered by the
  idempotent `!hub` retry re-asserting the tombstone.
- Legitimate intentional re-creation of the SAME master UUID after a delete is
  blocked (visible) rather than auto-cleared, by design (§10: no naive
  create-clears-tombstone); requires explicit operator reconciliation.

## Batch: F-07 company-profile atomicity (3A) + backup/restore sync state (3B) — verified 2026-09-12

### STATUS
Complete and verified. The working-tree fix for `PUT /api/company/profile` was already
written when the previous run was aborted; this batch verified it end to end, swept the
rest of the codebase for the same defect class, and verified the backup/restore sync-state
work against live PostgreSQL and three real servers.

### REAL PROBLEMS FOUND
1. `backend/src/presentation/routes/company.route.ts` (PUT /api/company/profile): the
   profile upsert and its outbox unit did not share a transaction. On the committed
   revision the route enqueued nothing at all (the profile was never synced); the
   intermediate working-tree state enqueued AFTER the repository's own
   `withTenantTx` had committed, inside a log-only `try/catch`. Counterfactual,
   reproduced live with a real BEFORE INSERT trigger on `sync_outbox`
   (`scripts/verify-f07-outbox-atomicity.mjs` §4b): with the pre-fix route the request
   returned HTTP 200, wrote `company_profiles` and left `sync_outbox` empty — a saved
   profile with no sync unit. With the fix: HTTP 500 `SYNC_OUTBOX_FAILED`, profile
   unchanged, no outbox row.
2. `scripts/test-f08-resource-claims.mjs` (verification only, not product code): ten
   checks failed with HTTP 400 because the drill predated the `expectedVersion`
   requirement on update/cancel routes (T9 invoice cancel, T11/T12 party rename,
   T13/T20 order edit). No product defect — the 400 is the intended P0-001 contract.

### FALSE POSITIVES
- `tests/audit-findings.test.ts` "fails" only because no backend is listening on
  127.0.0.1:8080 (ECONNREFUSED) and `erp` has no tenant/admin fixture; environmental,
  pre-existing, file unmodified.
- `backend/scripts/verify-rls.mjs` fails against the live `erp` database and against
  `sync_tpl` because neither has had the canonical policy layer applied
  (`enable-rls.sql`, not a drizzle migration). A fresh database built with
  `drizzle-kit migrate` + `scripts/apply-rls.mjs` PASSES the same script
  (`tenant_isolation=36, platform_or_tenant=8, tenant_directory=1, platform_only=1`,
  46 tables). The `erp` database is STALE relative to this batch, not broken by it.
- `statement.route.ts` frozen-leg capture `logger.warn` is NOT a lost sync unit: the
  read it guards runs inside the settlement transaction, so any Postgres error aborts
  the transaction and the following enqueue fails loudly (500). Left as-is.

### CHANGES MADE
- `backend/scripts/test-f08-resource-claims.mjs`: added a `versionOf(db, table, id)`
  helper (reads the row's version from the DB the request will run against) and passed
  `expectedVersion` on the five update/cancel calls that require it; corrected the
  copy-pasted Usage/header text. Drill now 55/55 (was 45/55).
- No production code changed in this batch — the F-07 route fix was already on disk
  (mtime 17:09:26) and was only verified here.

### MIGRATIONS
- `20260915_fabric_color_version.sql` is legitimate and required: `fabrics.version` /
  `colors.version` are declared in the Drizzle schemas and used by the repositories
  (optimistic locking + `enqueueMasterUpdate` base version), but no migration created
  them, so migrated databases failed master creation with 42703. Additive
  (`ADD COLUMN IF NOT EXISTS ... DEFAULT 1`), re-runnable, journal idx 62 immediately
  after `20260914_sync_rls_canonical_policies`, and enforced by
  `tests/schema-migration-parity.test.ts`. Verified applied on a fresh database
  (63 migrations; both columns present with default 1).

### TESTS RUN (2026-09-12)
- `npm run typecheck` → exit 0; `npm run typecheck:backend` → exit 0.
- `npm run test:logic` → exit 0, 22 files / 123 tests.
- `cd backend && npx vitest run` → exit 1: 23 files passed / 1 failed
  (`audit-findings.test.ts`, live-API-only), 232 passed | 10 skipped.
- `npx vitest run tests/restore-sync-state.test.ts tests/sync-outbox-ambient-wiring.test.ts
  tests/schema-migration-parity.test.ts tests/rls-guard.test.ts
  tests/migrations-journal-guard.test.ts tests/sync-invariants.test.ts
  tests/sync-cancel-base-version.test.ts` → 7 files / 115 tests passed.
- `node backend/scripts/verify-restore-sync-state.mjs` → exit 0, 35/35 checks.
- `node backend/scripts/test-sync-drills.mjs` → exit 0, 6/6 checks (D1–D4).
- `node backend/scripts/verify-f07-outbox-atomicity.mjs` → exit 0, 38/38 checks.
- `node backend/scripts/test-f08-resource-claims.mjs` → exit 0, 55/55 checks.
- Fresh-DB RLS chain: `drizzle-kit migrate` → `apply-rls.mjs` → `verify-rls.mjs` → exit 0.

### REGRESSION RESULTS
- No regression: the single failing backend suite is the environmental live-API test.
- F-08 improved from 45/55 to 55/55 by fixing the stale drill, not the product.

### REMAINING RISKS / NOT CHANGED
- Live `erp` database still carries pre-batch legacy RLS policy names; applying
  `scripts/apply-rls.mjs` (or `db:migrate` + re-apply) is an operator step that was
  NOT performed here because the task forbids modifying `erp`.
- Restored `document_number_blocks` can be stale if a block tail was reclaimed and
  re-carved after the backup; the restore script prints blocks vs sequences so this
  can be checked (documented in the script and SYNC-OPERATIONS.md).
- `sync_conflicts` resolution flow remains operator-driven (from the previous batch).
