/**
 * Sync-engine invariant guards.
 *
 * Every assertion here locks in a root cause that was found by a LIVE
 * multi-device acceptance run (`scripts/verify-sync-multidevice.mjs`), so the
 * same defect cannot silently come back. Each test names the finding it
 * guards and the exact production symptom it prevents.
 *
 * These are deliberately static/structural: they are fast, need no database,
 * and they fail loudly the moment someone edits one half of a two-place
 * invariant (TypeScript union ↔ SQL CHECK constraint, or a call site that
 * stops passing the device id).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(BACKEND_ROOT, ...parts), "utf8");

const MIGRATIONS = join("src", "infrastructure", "orm", "migrations");

function allMigrationsSql(): string {
  return readdirSync(join(BACKEND_ROOT, MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => read(MIGRATIONS, f))
    .join("\n");
}

describe("sync invariants — notification kinds (live run 2026-09-10)", () => {
  /**
   * Symptom this guards: the sync engine wrote conflict notices with
   * `kind = 'sync'`, the TS union already allowed it, but the DB CHECK
   * constraint did not — so EVERY insert failed with
   * `notifications_kind_check` and was swallowed by the caller's catch.
   * Conflict losers were never notified and `notifications` stayed empty.
   */
  it("the notifications CHECK constraint accepts every NotificationKind", () => {
    // The canonical union lives in the backend domain types; the frontend
    // mirrors it. Both must stay inside the DB constraint.
    const sources = [
      read("src", "domain", "types", "index.ts"),
      readFileSync(
        join(BACKEND_ROOT, "..", "src", "application", "ports", "INotificationRepository.ts"),
        "utf8",
      ),
    ];

    const kinds = new Set<string>();
    for (const src of sources) {
      const m = /export type NotificationKind\s*=\s*([^;]+);/.exec(src);
      if (!m) continue;
      for (const k of m[1].matchAll(/"([^"]+)"/g)) kinds.add(k[1]);
    }
    expect(kinds.size, "NotificationKind union not found").toBeGreaterThan(0);
    expect(kinds.has("sync"), "the sync engine's notice kind must be declared").toBe(true);

    // Find the LAST definition of the constraint — a later migration may
    // widen it (that is exactly how 'sync' was added).
    const sql = allMigrationsSql();
    const defs = [
      ...sql.matchAll(/ADD CONSTRAINT notifications_kind_check\s+CHECK\s*\(([^)]*)\)/g),
    ];
    expect(defs.length, "notifications_kind_check never defined").toBeGreaterThan(0);
    const finalDef = defs[defs.length - 1][1];
    const allowed = [...finalDef.matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const missing = [...kinds].filter((k) => !allowed.includes(k));
    expect(
      missing,
      `NotificationKind values missing from notifications_kind_check: ${missing.join(", ")} — ` +
        `inserting them will fail with a CHECK violation`,
    ).toEqual([]);
  });
});

describe("sync invariants — offline document numbering (party code collision)", () => {
  /**
   * Symptom this guards: two offline devices both minted `CUS-<year>-0001`
   * because party codes were never block-allocated, so the second party insert
   * on the hub violated `parties (tenant_id, code)` and the sync unit was
   * stranded in `received` forever.
   */
  it("every entity type with a prefix also has a reserved block size", () => {
    const src = read("src", "infrastructure", "utils", "documentNumbers.ts");
    const prefixBlock = /const PREFIXES[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
    const sizeBlock =
      /export const DEFAULT_BLOCK_SIZES[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? "";

    const prefixes = new Set([...prefixBlock.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));
    const sizes = new Set([...sizeBlock.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));

    // Master data is created on offline devices exactly like documents, so it
    // must be able to draw from a reserved block.
    for (const required of ["customer", "supplier"]) {
      expect(prefixes.has(required), `PREFIXES is missing ${required}`).toBe(true);
      expect(
        sizes.has(required),
        `DEFAULT_BLOCK_SIZES is missing ${required} — a device will fall back to ` +
          `its local sequence and collide with another node`,
      ).toBe(true);
    }
  });

  it("automatic number blocks are provisioned for customer and supplier", () => {
    const src = read("src", "application", "use-cases", "sync", "numberBlockUseCases.ts");
    const list = /const PRIMARY_ENTITY_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
    for (const required of ["customer", "supplier"]) {
      expect(
        list.includes(`"${required}"`),
        `PRIMARY_ENTITY_TYPES must include ${required} so /sync/run provisions its block`,
      ).toBe(true);
    }
  });

  it("party creation allocates its code from the device block", () => {
    const src = read("src", "infrastructure", "repositories", "PostgresPartyRepository.ts");
    const call = /allocateDocumentNumber\(([\s\S]*?)\)\);/.exec(src)?.[1] ?? "";
    expect(call, "allocateDocumentNumber call not found in party repository").not.toBe("");
    expect(
      call.includes("syncDeviceId"),
      "PostgresPartyRepository must pass syncDeviceId — without it every node " +
        "draws from its own local sequence and two offline devices collide on " +
        "parties (tenant_id, code)",
    ).toBe(true);
  });
});

describe("sync invariants — no silent discard of unmaterializable units", () => {
  /**
   * Symptom this guards (F-14): `materializeSyncUnit` returned `skipped` for
   * malformed/unsupported payloads, and the caller treated `skipped` as
   * success — marking the unit `applied` and losing the operation while
   * reporting success.
   */
  it("materialize never reports an unknown payload as a success status", () => {
    const src = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
    const resultType = /MaterializeResult[\s\S]*?status:\s*([^;]+);/.exec(src)?.[1] ?? "";
    expect(resultType).not.toBe("");
    expect(
      resultType.includes('"skipped"'),
      'the "skipped" status must not exist — unknown payloads must be "invalid"',
    ).toBe(false);
    expect(resultType.includes('"invalid"')).toBe(true);
  });

  it("an invalid unit is parked as dead, never marked applied", () => {
    const src = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
    expect(
      src.includes("inbox.markDead"),
      "syncUseCases must park permanently-invalid units with markDead",
    ).toBe(true);
  });
});

describe("sync invariants — monotonic cursors, not timestamps", () => {
  /**
   * Symptom this guards (F-02): the pull cursor was a timestamp compared with
   * a strict `>`. `received_at` is transaction-start time, so rows sharing a
   * timestamp were skipped forever and units received before the cursor but
   * applied after it were unreachable.
   */
  it("the pull cursor is a bigint sequence", () => {
    const stateSchema = read("src", "infrastructure", "orm", "schemas", "sync-state.table.ts");
    expect(stateSchema.includes("lastPullSeq")).toBe(true);
    expect(stateSchema.includes("bigint")).toBe(true);
  });

  it("outbox and inbox expose monotonic sequences", () => {
    expect(
      read("src", "infrastructure", "orm", "schemas", "sync-outbox.table.ts").includes("bigserial"),
    ).toBe(true);
    expect(
      read("src", "infrastructure", "orm", "schemas", "sync-inbox.table.ts").includes(
        "receivedSeq",
      ),
    ).toBe(true);
  });
});

describe("sync invariants — a stuck unit must not stall the whole stream", () => {
  /**
   * Symptom this guards (found live 2026-09-10): a structurally broken master
   * snapshot returned `failed` (retryable). The pull stream holds its cursor at
   * the first retryable unit to preserve hub ordering, so ONE bad unit froze
   * device A's cursor at seq 8 while 5 valid units sat behind it — including
   * two real customer records that never arrived.
   */
  it("master snapshots are structurally validated before being applied", () => {
    const src = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
    expect(
      src.includes("validateMasterSnapshot"),
      "materializeMasterCreate must validate the snapshot shape so a broken " +
        "payload is classified permanent (invalid) instead of retryable (failed)",
    ).toBe(true);
    // The validator must actually be consulted, not merely defined.
    expect(
      /const structural = validateMasterSnapshot\(/.test(src),
      "the validator's result must be used to short-circuit the apply",
    ).toBe(true);
  });

  it("pulled units are mirrored locally so their retries are bounded", () => {
    const src = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
    const pull =
      /export async function runLocalSyncPull\(([\s\S]*?)\n\): Promise/.exec(src)?.[1] ?? "";
    expect(pull, "runLocalSyncPull signature not found").not.toBe("");
    expect(
      pull.includes("inbox"),
      "runLocalSyncPull must accept the local inbox — without it a retryable " +
        "unit holds the cursor forever and every later operation is lost",
    ).toBe(true);
    expect(
      src.includes("exhausted its attempt budget"),
      "the pull path must park a unit as dead once its attempt budget is spent",
    ).toBe(true);
  });

  it("the route passes the inbox into the pull so the guard is live", () => {
    const src = read("src", "presentation", "routes", "sync.route.ts");
    const call = /runLocalSyncPull\(([\s\S]*?)\);/.exec(src)?.[1] ?? "";
    expect(call).not.toBe("");
    expect(
      call.includes("syncInboxRepo"),
      "sync.route must pass container.syncInboxRepo to runLocalSyncPull",
    ).toBe(true);
  });
});

describe("sync invariants — cancelled documents release their claims", () => {
  /**
   * Symptom this guards (F-08): an invoice create claims `roll:<id>` for every
   * roll it consumes and nothing ever released them, so after a cancel the
   * rolls stayed reserved forever and every later sale from any device was
   * rejected as a conflict.
   *
   * The repository behaviour itself is covered against a real database in
   * `sync-claim-release.test.ts`; this guards the WIRING, which is the part
   * that was missing entirely.
   */
  it("the hub releases claims after a document cancel is applied", () => {
    const src = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
    expect(
      src.includes("releaseClaimsAfterApply"),
      "receiveSyncPush must release the cancelled document's resource claims",
    ).toBe(true);
    expect(
      /if \(materialized\) await releaseClaimsAfterApply\(/.test(src),
      "the release must be gated on the cancel having actually been applied — " +
        "releasing on a failed cancel would let another device sell the same roll",
    ).toBe(true);
  });

  it("the claim repository exposes a release path", () => {
    expect(
      read("src", "application", "ports", "ISyncResourceClaimRepository.ts").includes(
        "releaseByEntity",
      ),
      "the port must expose releaseByEntity — without it claims can only be created",
    ).toBe(true);
  });
});

describe("sync invariants — retryable vs permanent hub failures", () => {
  /**
   * Symptom this guards (F-05): every non-409 4xx was treated as a permanent
   * rejection, so a single transient 401 marked the whole outbox `rejected`
   * forever with no local rollback.
   */
  it("transient hub statuses reset the unit to pending instead of rejecting it", () => {
    const src = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
    expect(src.includes("isRetryablePushStatus")).toBe(true);
    for (const status of ["401", "403", "408", "425", "429"]) {
      expect(src.includes(status), `retryable status ${status} not handled`).toBe(true);
    }
  });
});

describe("sync invariants — Transactional Outbox (F-07)", () => {
  /**
   * THE INVARIANT:
   *   "Every successful offline business mutation must have a durable
   *    corresponding outbox operation in the same transaction."
   *
   * Symptom this guards (F-07): each route ran the business use-case (commit)
   * and only THEN inserted the outbox row on a separate pooled connection,
   * inside `try { ... } catch { logger.warn }`. If that insert failed, the
   * document stayed committed locally with no sync unit — silent divergence
   * that nothing could repair, because no process re-scans business tables for
   * un-enqueued writes. The runtime proof lives in
   * `scripts/verify-f07-outbox-atomicity.mjs` (real PostgreSQL + injected
   * outbox failure); these guards are the static half, so the pattern cannot
   * come back unnoticed in a route nobody re-tests.
   */
  const ROUTES_DIR = join("src", "presentation", "routes");

  /** Routes that enqueue an outbox unit after a business mutation. */
  const ENQUEUING_ROUTES = [
    "invoice.route.ts",
    "return.route.ts",
    "order.route.ts",
    "expense.route.ts",
    "voucher.route.ts",
    "party.route.ts",
    "fabric.route.ts",
    "color.route.ts",
    "roll.route.ts",
  ];

  it("every enqueuing route binds the write and the outbox unit in ONE withTenantTx", () => {
    for (const f of ENQUEUING_ROUTES) {
      const src = read(ROUTES_DIR, f);
      expect(
        src.includes("withTenantTx"),
        `${f} must wrap its write in withTenantTx — otherwise the document commits ` +
          `before its outbox unit and a failed enqueue silently loses the operation forever`,
      ).toBe(true);
    }
  });

  it("no route swallows an outbox enqueue failure into a warn", () => {
    for (const f of ENQUEUING_ROUTES) {
      const src = read(ROUTES_DIR, f);
      // The old shape was: try { await enqueue* } catch { logger.warn("sync
      // outbox enqueue failed after ...") }. Any surviving swallow message is a
      // regression to exactly the F-07 divergence.
      expect(
        /sync outbox enqueue failed after/.test(src),
        `${f} still swallows an outbox enqueue failure — a swallowed failure ` +
          `means a locally-saved document that never syncs`,
      ).toBe(false);
      expect(
        /catch \(err\)\s*\{\s*logger\.warn/.test(src),
        `${f} still has a catch(logger.warn) around the enqueue`,
      ).toBe(false);
    }
  });

  it("the outbox repository and the business repos share the ambient transaction", () => {
    // The mechanism: repositories are constructed with an ambient-aware db
    // proxy, and withTenantTx publishes its transaction to that proxy. Without
    // BOTH halves the outbox insert silently runs on a second connection and
    // the atomicity guarantee is vacuous.
    const drizzle = read("src", "infrastructure", "orm", "drizzle.ts");
    expect(
      drizzle.includes("runInAmbientTx"),
      "withTenantTx must publish its transaction as the ambient tx",
    ).toBe(true);

    const container = read("src", "infrastructure", "di", "container.ts");
    expect(
      container.includes("ambientDb(db)"),
      "container must build repositories with ambientDb(db)",
    ).toBe(true);
    expect(
      /new PostgresSyncOutboxRepository\(dbx\)/.test(container),
      "the outbox repository must be ambient-aware — it is half of the atomic pair",
    ).toBe(true);
  });

  it("the failure path is a hard error, never a success response", () => {
    for (const f of ENQUEUING_ROUTES) {
      const src = read(ROUTES_DIR, f);
      // Two legitimate shapes, both of which answer with a non-2xx + an
      // explicit code:
      //  1. the route emits the code inline, or
      //  2. the route delegates to `respondTransactionFailure` — the shared
      //     helper that maps a rolled-back transaction onto SYNC_OUTBOX_FAILED.
      // The helper's own contract is asserted by the next test, so delegating
      // cannot become a loophole here.
      const inline = src.includes("SYNC_OUTBOX_FAILED");
      const viaHelper = src.includes("respondTransactionFailure(");
      expect(
        inline || viaHelper,
        `${f} must surface a failed enqueue as an explicit error code so the ` +
          `caller is not told the mutation succeeded`,
      ).toBe(true);
    }
  });

  it("the shared transaction-failure helper answers non-business failures with SYNC_OUTBOX_FAILED", () => {
    // This is what makes the delegation allowed above safe. `respondTransactionFailure`
    // must default to SYNC_OUTBOX_FAILED and only downgrade to VALIDATION for
    // real business-rule failures (422) — anything else would report a failed
    // outbox enqueue as a different kind of problem.
    const helper = read("src", "infrastructure", "http", "transactionRouteError.ts");
    expect(
      helper.includes('syncCode = "SYNC_OUTBOX_FAILED"'),
      "respondTransactionFailure must default to the SYNC_OUTBOX_FAILED code",
    ).toBe(true);
    expect(
      helper.includes('status === 422 ? "VALIDATION" : syncCode'),
      "only business-rule/day-locked failures may leave the SYNC_OUTBOX_FAILED path",
    ).toBe(true);
  });
});

describe("sync invariants — Resource claims (F-08)", () => {
  /**
   * THE INVARIANT:
   *   \"Master data creation (party, fabric, color, roll) must NOT claim
   *    sync resources. Resource claims exist to prevent concurrent mutations
   *    of shared stock (e.g. two invoices selling the same roll). Master data
   *    is an idempotent entity-lifecycle operation — it should never
   *    conflict with transactions that reference the entity.\"
   *
   * Symptom this guards (F-08): roll creation claimed `roll:<rollId>`, which
   * conflicted with invoice creation's claim on the same resource. The invoice
   * was rejected by the hub even though it legitimately depends on the roll
   * existing — silent data loss that no repair process could fix.
   *
   * The fix: extractConflictResources returns [] for master data create.
   * Dependency ordering is handled by the dependency snapshot system, not by
   * resource claims.
   */
  const SYNC_USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");

  it("extractConflictResources does not claim resources for master data creation", () => {
    // The old shape returned `[{ resourceType: entityType, resourceId: snap.id }]`
    // for party/fabric/roll/color create. Any surviving return of that shape is a
    // regression to exactly the F-08 divergence.
    expect(
      /entityType === "party".*entityType === "rollup.*operation === "create".*resourceType: entityType/s.test(
        SYNC_USECASES,
      ),
      "master data creation must NOT claim resources — roll creation claimed roll:<id> and blocked invoices",
    ).toBe(false);
  });

  it("master data create payloads carry a snapshot for dependency resolution, not a claim", () => {
    // The snapshot path must still exist — it is how the hub materializes the
    // entity. Only the *claim* is removed; the snapshot is untouched.
    expect(
      SYNC_USECASES.includes("snapshot"),
      "master data create must still carry a snapshot for materialization",
    ).toBe(true);
  });
});

describe("sync invariants — rejected-unit reconciliation (P1-step-1)", () => {
  /**
   * THE INVARIANT:
   *   "No terminally-rejected sync unit may leave an active local document
   *    behind without a resolution record. Every created document type rolls
   *    back through its own cancel use-case; anything that cannot be safely
   *    auto-reverted resolves to a flagged kind='sync' notification with
   *    manual-resolution guidance — visible, never silent."
   *
   * Symptom this guarded against: rollbackRejectedUnitLocally handled only
   * invoice/create, so a rejected voucher/return/order/expense stayed active
   * locally forever while the hub would never accept it — a permanent,
   * silent fork per rejected unit.
   */
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const PORT = read("src", "application", "ports", "ISyncResourceClaimRepository.ts");
  const CLAIMS_REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresSyncResourceClaimRepository.ts",
  );
  const ROUTES = read("src", "presentation", "routes", "sync.route.ts");

  it("every created document type has a wired cancel path in the rollback", () => {
    for (const entity of ["invoice", "voucher", "return", "order", "expense"]) {
      expect(
        USECASES.includes(`case "${entity}"`),
        `rollback must handle ${entity}/create — an unwired type forks silently on rejection`,
      ).toBe(true);
    }
    for (const fn of [
      "cancelInvoiceUseCase",
      "cancelVoucherUseCase",
      "cancelReturnUseCase",
      "cancelOrderUseCase",
      "cancelExpenseUseCase",
    ]) {
      expect(
        USECASES.includes(fn),
        `rollback must call ${fn} — the domain's own reversal, not a hand-rolled delete`,
      ).toBe(true);
    }
  });

  it("rollback checks the cancel Result instead of assuming success", () => {
    // Cancel use-cases return Result (they refuse settled/locked documents
    // instead of throwing). Ignoring .ok would report a refused cancel as
    // rolled back — a lie that re-hides the fork.
    expect(
      USECASES.includes("local rollback cancel refused"),
      "a business-refused cancel must surface as rollback-failed, never as rolled-back",
    ).toBe(true);
  });

  it("update and cancel losers resolve to flagged guidance, never silent revert", () => {
    expect(
      USECASES.includes('unit.operation === "update"') &&
        USECASES.includes('unit.operation === "cancel"'),
      "update/cancel rejections must produce explicit manual-resolution guidance",
    ).toBe(true);
  });

  it("permanent (non-retryable, non-conflict) rejections reconcile like conflict losers", () => {
    // The old shape marked the outbox row rejected and moved on, leaving the
    // local record active — the same fork as a conflict, without even a notice.
    const pushSection = USECASES.slice(USECASES.indexOf("isRetryablePushStatus(res.status)"));
    expect(
      /markRejected[\s\S]{0,600}rollbackRejectedUnitLocally/.test(pushSection),
      "the permanent-rejection branch must reconcile locally, not just mark the row",
    ).toBe(true);
  });

  it("the claim port exposes inventory and op-scoped release", () => {
    expect(PORT.includes("listByTenant"), "operator inventory needs listByTenant").toBe(true);
    expect(PORT.includes("releaseByOp"), "terminal-only reap needs releaseByOp").toBe(true);
    expect(
      CLAIMS_REPO.includes("listByTenant") && CLAIMS_REPO.includes("releaseByOp"),
      "the Postgres claim repository must implement both",
    ).toBe(true);
  });

  it("the claim reap is terminal-gated on dead holder status", () => {
    expect(
      USECASES.includes("reapTerminalSyncClaims") && /holderStatus === "dead"/.test(USECASES),
      "reap must release only claims whose holder op is dead — live reservations are kept",
    ).toBe(true);
    expect(
      ROUTES.includes("/sync/claims/reap") && ROUTES.includes("/sync/claims"),
      "operators need the inventory and reap endpoints wired",
    ).toBe(true);
  });
});

describe("sync invariants — dependency ordering (P1-step-2)", () => {
  /**
   * THE INVARIANTS:
   *  (a) One canonical party-snapshot mapping. Three capture paths used to
   *      carry their own inline 25-field copy; a field added in one place and
   *      missed in another replays a silently incomplete party on the hub.
   *  (b) Dependency sets apply atomically. ensureInvoiceSyncDependencies ran
   *      insert-if-missing per table with no transaction, so a crash left a
   *      half-applied set (party without its roll) that replays tripped on.
   *  (c) Every create path honors dependencies. Expense bypassed ensureDeps,
   *      so a future expense dependency would skip ordering silently.
   */
  const SNAPS = read("src", "application", "use-cases", "sync", "syncDependencySnapshots.ts");
  const MATERIALIZE = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const ENQUEUE = read("src", "application", "use-cases", "sync", "syncEnqueue.ts");
  const VOUCHER_ROUTE = read("src", "presentation", "routes", "voucher.route.ts");
  const ORDER_ROUTE = read("src", "presentation", "routes", "order.route.ts");

  it("party snapshots come from exactly one mapping function", () => {
    expect(SNAPS.includes("export function toPartySnapshot"), "canonical mapper must exist").toBe(
      true,
    );
    for (const [name, src] of [
      ["captureInvoiceSyncDependencies", SNAPS],
      ["captureReturnSyncDependencies", SNAPS],
      ["capturePartySyncDependencies", SNAPS],
    ] as const) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const nextExport = body.indexOf("export async function", 10);
      const fn = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(
        fn.includes("toPartySnapshot(p)"),
        `${name} must map parties through toPartySnapshot — an inline copy drifts`,
      ).toBe(true);
    }
    for (const [name, src] of [
      ["voucher.route", VOUCHER_ROUTE],
      ["order.route", ORDER_ROUTE],
    ] as const) {
      expect(
        src.includes("capturePartySyncDependencies"),
        `${name} must capture through the shared helper, not an inline mapping`,
      ).toBe(true);
      expect(
        /parties:\s*\[\s*\{/.test(src),
        `${name} must not contain its own inline party-snapshot object`,
      ).toBe(false);
    }
  });

  it("dependency sets apply in one database transaction", () => {
    expect(
      SNAPS.includes("await database.transaction(async (tx)"),
      "ensure must wrap the whole dep set in a single transaction (SYNC-08)",
    ).toBe(true);
    expect(
      /ensureInvoiceSyncDependenciesInTx\([\s\S]{0,200}tx, deps, ctx/.test(SNAPS),
      "every statement in the ensure body must run on the transaction handle",
    ).toBe(true);
  });

  it("expense create honors dependencies like every other create path", () => {
    expect(
      ENQUEUE.includes("dependencies?: InvoiceSyncDependencies | null") &&
        /enqueueExpenseCreate\([\s\S]{0,400}dependencies/.test(ENQUEUE),
      "enqueueExpenseCreate must accept and persist dependencies",
    ).toBe(true);
    expect(
      /materializeExpenseCreate\([\s\S]{0,1500}ensureDeps\(database, payload, ctx\)/.test(
        MATERIALIZE,
      ),
      "materializeExpenseCreate must run ensureDeps before replay",
    ).toBe(true);
  });

  it("voucher replay with a missing linked invoice stays retryable, never dead", () => {
    // createVoucherUseCase refuses unknown business links with ok:false; the
    // materialize layer must map that to retryable `failed` (converging when
    // the invoice arrives), not permanent `invalid` (parking good money dead).
    const fn = MATERIALIZE.slice(MATERIALIZE.indexOf("async function materializeVoucherCreate"));
    expect(
      /if \(!created\.ok\) return \{ status: "failed"/.test(fn),
      "use-case refusal must be retryable",
    ).toBe(true);
  });
});

describe("sync invariants — quantity-aware claims (P3a)", () => {
  /**
   * THE INVARIANTS:
   *  (a) Stock claims reserve kilograms, not whole rolls. Any second touch of
   *      the same roll used to 409 unconditionally — legitimate concurrent
   *      part-quantity sales were refused with no recourse.
   *  (b) Whole-resource semantics survive for identity namespaces (voucher,
   *      order, expense, cancels) and legacy payloads without lines.
   *  (c) Reservations never double-count: applied holders already decremented
   *      stock, dead holders never retry — both are excluded from outstanding.
   *  (d) Claim checks serialize on the hub roll row; over-claims report the
   *      remaining quantity instead of a bare conflict.
   */
  const REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresSyncResourceClaimRepository.ts",
  );
  const PORT = read("src", "application", "ports", "ISyncResourceClaimRepository.ts");
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const SCHEMA = read("src", "infrastructure", "orm", "schemas", "sync-resource-claim.table.ts");
  const MIGRATIONS = read(
    "src",
    "infrastructure",
    "orm",
    "migrations",
    "0055_sync_claim_quantities.sql",
  );

  it("claim rows carry kilogram reservations with split unique semantics", () => {
    expect(SCHEMA.includes("quantity_kg"), "schema must persist quantity_kg").toBe(true);
    expect(PORT.includes("quantityKg"), "port must type quantityKg").toBe(true);
    expect(
      MIGRATIONS.includes("uq_sync_claims_identity") &&
        MIGRATIONS.includes("uq_sync_claims_qty_op") &&
        MIGRATIONS.includes('WHERE "quantity_kg" IS NULL') &&
        MIGRATIONS.includes('WHERE "quantity_kg" IS NOT NULL'),
      "identity guards stay single-winner while quantity rows coexist per-op",
    ).toBe(true);
  });

  it("quantity checks lock the roll row and exclude settled holders", () => {
    expect(
      REPO.includes('.for("update")'),
      "concurrent claim txs must serialize on the roll row",
    ).toBe(true);
    expect(
      REPO.includes('"applied"') && REPO.includes('"dead"') && /settled\.add\(s\.opId\)/.test(REPO),
      "applied holders (effect in stock) and dead holders (never retry) must be excluded",
    ).toBe(true);
    expect(
      REPO.includes("remainingKg - outstandingKg") && REPO.includes("remainingPc - outstandingPc"),
      "over-claims must report the remaining quantity in both dimensions",
    ).toBe(true);
  });

  it("unquantified requests keep whole-resource semantics", () => {
    expect(
      REPO.includes("r.quantityKg === null") || REPO.includes("quantityKg === null"),
      "NULL-quantity requests must take the classic single-winner path",
    ).toBe(true);
    expect(
      /sumDemandByRoll/.test(USECASES) &&
        USECASES.includes("demand?.get(resourceId)?.quantityKg ?? null"),
      "payloads without measurable lines must fall back to whole-resource claims, never zero",
    ).toBe(true);
  });

  it("invoice updates reserve net deltas, returns reserve conservatively", () => {
    expect(
      USECASES.includes("annotateUpdateClaimDeltas") &&
        USECASES.includes("Math.max(0, (cur.quantityKg ?? 0) - (old.quantityKg ?? 0))") &&
        USECASES.includes("Math.max(0, (cur.quantityPieces ?? 0) - (old.quantityPieces ?? 0))"),
      "updates must reserve new-minus-old per dimension (notes-only edits reserve zero)",
    ).toBe(true);
    expect(
      /return_roll[\s\S]{0,400}quantityKg/.test(USECASES),
      "returns must reserve kilograms (no phantom availability for unapplied returns)",
    ).toBe(true);
  });

  it("updates and creates contend in one roll pool", () => {
    expect(
      USECASES.includes('resourceType: "roll"') &&
        !/resourceType: operation === "update" \? "invoice_update_roll"/.test(USECASES),
      "updates must reserve from the same roll pool as creates — separate namespaces allow joint oversell",
    ).toBe(true);
  });

  it("conflict detail and message carry quantities", () => {
    expect(
      USECASES.includes("availableKg: c.availableKg ?? null") &&
        USECASES.includes("requestedKg: c.requestedKg ?? null"),
      "conflict provenance must include available/requested kilograms",
    ).toBe(true);
    expect(
      USECASES.includes("المتاح") && USECASES.includes("المطلوب"),
      "loser message must quote figures",
    ).toBe(true);
  });
});

describe("sync invariants — update base-version (P3b)", () => {
  /**
   * THE INVARIANTS:
   *  (a) Every update unit carries the pre-edit version its device saw, read
   *      in the same transaction as the edit — without it the hub cannot tell
   *      a fresh edit from a stale overwrite.
   *  (b) Duplicate delivery of an applied edit converges to `exists` (the hub
   *      row already reflects the exact intent) instead of failing forever.
   *  (c) A stale base fails retryably with the exact differing fields (for an
   *      operator rebase), never `invalid`, never a silent overwrite.
   *  (d) Payloads without a baseVersion are refused (visible conflict) —
   *      never applied as last-write-wins against the hub row.
   */
  const MATERIALIZE = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const ENQUEUE = read("src", "application", "use-cases", "sync", "syncEnqueue.ts");
  const ROUTE = read("src", "presentation", "routes", "invoice.route.ts");

  it("the update path stamps the pre-edit version into the unit", () => {
    expect(
      ENQUEUE.includes("baseVersion: baseVersion ?? null"),
      "payload must carry baseVersion",
    ).toBe(true);
    expect(
      ROUTE.includes("invoiceRepo.findById(pid(req), c)") &&
        ROUTE.includes("before?.version ?? null"),
      "route must read the pre-edit row in-tx and stamp its version",
    ).toBe(true);
  });

  it("materialize converges duplicates, rejects stale and missing bases", () => {
    const fn = MATERIALIZE.slice(MATERIALIZE.indexOf("async function materializeInvoiceUpdate"));
    expect(
      /differing\.length === 0\) return \{ status: "exists" \}/.test(fn),
      "converged duplicate must be exists",
    ).toBe(true);
    expect(
      /baseVersion === null && !meta\?\.hubCanonical[\s\S]{0,400}status: "failed"/.test(fn),
      "missing baseVersion must fail visibly (no silent overwrite)",
    ).toBe(true);
    expect(
      /baseVersion !== null && existing\.version !== baseVersion[\s\S]{0,300}status: "failed"/.test(
        fn,
      ) && /الحقول المختلفة/.test(fn),
      "stale base must fail retryably with the differing field list",
    ).toBe(true);
  });

  it("the diff compares normalized projections, not raw rows", () => {
    expect(
      MATERIALIZE.includes("export function diffUpdateInput") &&
        MATERIALIZE.includes("discountAmount: Number(l.discountAmount ?? 0)"),
      "lines must compare as normalized projections (hub rows carry ids the intent lacks)",
    ).toBe(true);
  });
});

describe("sync invariants — numbering completeness (P4)", () => {
  /**
   * THE INVARIANTS:
   *  (a) Every document type whose repository consumes blocks in-transaction
   *      is auto-provisioned — otherwise offline creation hard-fails (by
   *      design, fail-loud) on a fresh device. Every provisioned type needs
   *      PREFIX + WIDTH + DEFAULT_BLOCK_SIZE or minting/formatting breaks.
   *  (b) Order/expense codes are minted INSIDE the repository transaction
   *      from the device block — pre-minting from the shared sequence let two
   *      offline devices mint the same code (hub then merged the second order
   *      into `exists` and its data vanished) and burned numbers on rollback.
   *  (c) Supplied (replay) codes go through the pre-allocated path so the hub
   *      floor rises past replayed history instead of colliding with it.
   */
  const BLOCKS = read("src", "application", "use-cases", "sync", "numberBlockUseCases.ts");
  const ORDER_REPO = read("src", "infrastructure", "repositories", "PostgresOrderRepository.ts");
  const EXPENSE_REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresExpenseRepository.ts",
  );
  const DOCNUMS = read("src", "infrastructure", "utils", "documentNumbers.ts");
  const STATUS_ROUTE = read("src", "presentation", "routes", "sync.route.ts");

  it("all eight block-consuming types are auto-provisioned with format data", () => {
    for (const t of [
      "invoice",
      "invoice_entry",
      "customer",
      "supplier",
      "voucher",
      "return",
      "expense",
      "order",
    ]) {
      expect(BLOCKS.includes(`"${t}"`), `PRIMARY_ENTITY_TYPES must include ${t}`).toBe(true);
    }
    for (const t of ["voucher", "return", "expense", "order"]) {
      expect(DOCNUMS.includes(`${t}:`), `DEFAULT_BLOCK_SIZES/PREFIXES must cover ${t}`).toBe(true);
    }
  });

  it("order/expense mint in-transaction from the device block", () => {
    for (const [name, src] of [
      ["order", ORDER_REPO],
      ["expense", EXPENSE_REPO],
    ] as const) {
      expect(
        src.includes('allocateDocumentNumber(tx, "') &&
          src.includes("syncDeviceId: ctx.syncDeviceId"),
        `${name} must mint from the device block inside its own transaction`,
      ).toBe(true);
      expect(
        src.includes("preAllocatedNumber: auto"),
        `${name} replay codes must raise the hub floor via the pre-allocated path`,
      ).toBe(true);
    }
    expect(
      /nextDocumentNumber\("order"|nextDocumentNumber\("expense"/.test(
        read("src", "presentation", "routes", "order.route.ts") +
          read("src", "presentation", "routes", "expense.route.ts"),
      ),
      "routes must not pre-mint order/expense codes from the shared sequence",
    ).toBe(false);
  });

  it("block health covers all provisioned types", () => {
    for (const t of ["voucher", "return", "expense", "order"]) {
      expect(STATUS_ROUTE.includes(`"${t}"`), `missingBlocks must watch ${t}`).toBe(true);
    }
  });
});

describe("sync invariants — voucher cancel coverage (P5)", () => {
  /**
   * THE INVARIANTS (SYNC-01):
   *  (a) Voucher cancellation flows through the outbox like every other
   *      cancel — it used to call the use-case directly, so a cancelling
   *      device diverged from all peers permanently (balances + ledger).
   *  (b) The hub can materialize voucher/cancel: missing id is invalid,
   *      missing row is retryable, already-cancelled converges to exists.
   *  (c) Cancel claims its own identity namespace (voucher_cancel), never
   *      stock — cancels release claims, they don't contend for them.
   */
  const ENQUEUE = read("src", "application", "use-cases", "sync", "syncEnqueue.ts");
  const MATERIALIZE = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const ROUTE = read("src", "presentation", "routes", "voucher.route.ts");

  it("voucher cancel is enqueued transactionally from both cancel endpoints", () => {
    expect(
      ENQUEUE.includes("export async function enqueueVoucherCancel"),
      "wrapper must exist",
    ).toBe(true);
    expect(
      (ROUTE.match(/enqueueVoucherCancel\(/g) ?? []).length >= 2,
      "both /payments/:id/cancel and /receipts/:id/cancel must enqueue",
    ).toBe(true);
    expect(
      (ROUTE.match(/withTenantTx\(c\.tenantId, runCancel\)/g) ?? []).length >= 2,
      "both cancel paths must share one transaction with their outbox unit (F-07)",
    ).toBe(true);
    expect(
      ROUTE.includes("SYNC_OUTBOX_FAILED") || ROUTE.includes("respondTransactionFailure("),
      "enqueue failure must be a hard error — either the inline SYNC_OUTBOX_FAILED " +
        "code or the shared respondTransactionFailure helper (whose default code " +
        "is asserted in the outbox section above)",
    ).toBe(true);
  });

  it("the hub materializes voucher/cancel with idempotent states", () => {
    expect(
      MATERIALIZE.includes('entityType === "voucher" && operation === "cancel"') &&
        MATERIALIZE.includes("materializeVoucherCancel"),
      "dispatcher must route voucher/cancel",
    ).toBe(true);
    const fn = MATERIALIZE.slice(MATERIALIZE.indexOf("async function materializeVoucherCancel"));
    expect(
      /missing voucherId/.test(fn) && /status: "invalid"/.test(fn),
      "missing id is invalid",
    ).toBe(true);
    expect(
      /status === "cancelled"\) return \{ status: "exists" \}/.test(fn),
      "re-cancel converges",
    ).toBe(true);
    expect(
      /cancelVoucherUseCase/.test(fn) && /status: "failed"/.test(fn),
      "missing row is retryable",
    ).toBe(true);
  });

  it("voucher cancel claims an identity namespace, not stock", () => {
    expect(
      USECASES.includes('resourceType: "voucher_cancel"'),
      "cancel must claim voucher_cancel (per-doc identity guard)",
    ).toBe(true);
  });
});

describe("sync invariants — replay trust boundary (P6)", () => {
  /**
   * THE INVARIANTS (SYNC-06 / SYNC-07):
   *  (a) Hub-side replay executes with the authenticated receiver's identity,
   *      never wire-supplied actor fields. Users are not synchronized, so a
   *      payload actor UUID usually does not exist here; trusting actorRole
   *      would let a forged push run with hub privileges it was never granted
   *      (and write created_by/cancelled_by FKs pointing at strangers).
   *  (b) Pull self-exclusion prefers the middleware-validated device binding
   *      over the query string. Exclusion stays an efficiency optimization —
   *      duplicate-apply safety rests on idempotent materialize, and pulls
   *      disclose nothing beyond the caller's own tenant either way.
   */
  const MATERIALIZE = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const ROUTE = read("src", "presentation", "routes", "sync.route.ts");

  it("replay identity ignores every wire-supplied actor field", () => {
    const fn = MATERIALIZE.slice(MATERIALIZE.indexOf("function replayCtxFromPayload"));
    expect(fn.includes("payload.actorRole"), "must not read actorRole from the wire").toBe(false);
    expect(fn.includes("payload.actorUserId"), "must not read actorUserId from the wire").toBe(
      false,
    );
    expect(fn.includes("payload.actorUserName"), "must not read actorUserName from the wire").toBe(
      false,
    );
    expect(
      fn.includes("userId: ctx.userId") &&
        fn.includes("userRole: ctx.userRole") &&
        fn.includes("userName: ctx.userName"),
      "authority and attribution must both be the authenticated receiver",
    ).toBe(true);
  });

  it("pull exclusion prefers the authenticated device binding", () => {
    expect(
      ROUTE.includes("const exclude = ctx.syncDeviceId ?? null") &&
        /query parameter[\s\S]+intentionally ignored/.test(ROUTE),
      "the exclusion must come only from the middleware-validated device binding",
    ).toBe(true);
  });
});

describe("sync invariants — run-result honesty (P7)", () => {
  /**
   * THE INVARIANTS (SYNC-15):
   *  (a) A failed pull/block-refill during /sync/run must appear in the run
   *      result. Zeros with no error read exactly like "in sync, nothing to
   *      do" — an operator cannot distinguish success from a hub outage.
   *  (b) A concurrency skip must not masquerade as "no session" (the old
   *      shared null), or dropped runs look like runs that were never needed.
   */
  const ROUTE = read("src", "presentation", "routes", "sync.route.ts");

  it("run failures surface as data, not silence", () => {
    expect(
      ROUTE.includes("pullError") && ROUTE.includes("blocksError"),
      "run result must carry both error fields",
    ).toBe(true);
    expect(
      /pullError = err instanceof Error \? err\.message/.test(ROUTE),
      "the actual pull failure message must be reported, not just logged",
    ).toBe(true);
    expect(
      ROUTE.includes("res.json({ ...push, deviceTrust, pull, pullError, blocksError })"),
      "fields must reach the client",
    ).toBe(true);
  });
});

describe("sync invariants — historical FX preservation (P8)", () => {
  /**
   * THE INVARIANTS (SYNC-14):
   *  (a) Hub replay recomputes ledger legs from the FROZEN input rate, never
   *      a current rate: every create materializer spreads the origin
   *      createInput verbatim, and no write path looks up "today's" rate.
   *  (b) Non-USD documents without a valid rate fail closed — a replay must
   *      never post unconvertible legs with a silently defaulted rate.
   */
  const MATERIALIZE = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const INVOICE_REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresInvoiceRepository.ts",
  );

  it("replay spreads the frozen createInput without overriding money fields", () => {
    for (const t of [
      "CreateInvoiceInput",
      "CreateVoucherInput",
      "CreateReturnInput",
      "CreateOrderInput",
      "CreateExpenseInput",
    ]) {
      expect(
        MATERIALIZE.includes(`...(createInput as ${t})`),
        `replay must spread ${t} verbatim`,
      ).toBe(true);
    }
    expect(
      /createInvoiceUseCase\([\s\S]{0,400}exchangeRate:/.test(MATERIALIZE),
      "replay must not substitute its own exchangeRate into invoice replay",
    ).toBe(false);
  });

  it("non-USD postings without a valid rate fail closed", () => {
    expect(
      INVOICE_REPO.includes("Fail closed for non-USD without rate") ||
        INVOICE_REPO.includes("FX_REQUIRED_MESSAGE"),
      "missing-rate documents must throw, never post unconvertible legs",
    ).toBe(true);
  });
});

describe("sync invariants — claim completion (P3a gate fixes)", () => {
  /**
   * THE INVARIANTS (found by the live T2/T2b gate run, not by review):
   *  (a) Pieces are a second stock dimension. The use-case guards pieces on
   *      every sale, so kg-only claims admitted phantom fits (10kg fit, the
   *      single piece already gone) that died invisibly in materialize.
   *  (b) The fit check is unconditional. With only settled holders it used to
   *      be skipped entirely (no live blocker → grant), so a sale bigger than
   *      the roll was accepted and died in materialize instead of 409ing with
   *      figures. Insufficient-stock with no holder reports the roll itself
   *      with a null winner, never a self-blaming op.
   *  (c) Accepted-but-unapplied hub units are retried, not abandoned. The
   *      device used to mark everything 2xx as synced, leaving `received`
   *      units with nobody retrying them. Now only materialized-or-terminal
   *      units count as synced; the rest re-push (bounded by the hub attempt
   *      budget) and hub-dead units surface visibly with a user notification.
   */
  const REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresSyncResourceClaimRepository.ts",
  );
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");

  it("claims measure pieces alongside kilograms", () => {
    expect(
      REPO.includes("quantityPieces") && REPO.includes("remainingPieces"),
      "pieces must be read, reserved, and persisted",
    ).toBe(true);
    expect(
      USECASES.includes("sumDemandByRoll") && USECASES.includes("pieces ?? 1"),
      "demand must mirror the domain piece default",
    ).toBe(true);
  });

  it("the fit check never depends on a live blocker existing", () => {
    expect(
      REPO.includes('"insufficient-stock"'),
      "stock-short units must 409 with figures, winner or not",
    ).toBe(true);
    expect(/blocker &&\s*\(/.test(REPO), "no blocker-gated grant may remain").toBe(false);
    expect(
      USECASES.includes('reason === "insufficient-stock"'),
      "winner-less conflicts must not blame an op",
    ).toBe(true);
  });

  it("push outcomes distinguish applied, dead, and still-working", () => {
    expect(USECASES.includes("terminal: row.status"), "hub must report terminality per unit").toBe(
      true,
    );
    expect(
      USECASES.includes("hub accepted but not yet applied — retrying"),
      "non-terminal accepts must re-push, never mark synced",
    ).toBe(true);
    expect(
      USECASES.includes("hubDead += 1") && USECASES.includes("hubDeadOps"),
      "hub-dead must be counted visibly",
    ).toBe(true);
  });
});

describe("sync invariants — historical FX preservation (SYNC-14)", () => {
  /**
   * THE INVARIANTS:
   *  Hub replay must reproduce the origin device's ledger legs exactly. Rates
   *  are frozen in the payload (createInput carries currency + exchangeRate);
   *  replay recomputes from those frozen inputs and NEVER substitutes a
   *  "current" rate, and non-USD documents without a valid rate fail closed
   *  instead of posting at a guessed rate. Proven live by the P8 FX proof
   *  (direct create vs hub replayed create → identical ledger legs).
   */
  const MAT = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");

  it("replay passes frozen create inputs verbatim, overriding no rate", () => {
    expect(
      /createInvoiceUseCase[\s\S]{0,300}\.\.\.\(createInput as/.test(MAT),
      "invoice replay must spread the frozen input",
    ).toBe(true);
    expect(/exchangeRate:\s*[^?]/.test(MAT), "replay must not override any rate field").toBe(false);
  });

  it("replay performs no current-rate lookup", () => {
    expect(
      /getCurrentRate|latestRate|todayRate|currentFx/i.test(MAT),
      "no ambient-rate symbol may appear in the replay path",
    ).toBe(false);
  });
});

describe("sync invariants — coverage completion (SYNC-12/13)", () => {
  /**
   * THE INVARIANTS:
   *  Every mutating endpoint is either synced (enqueue + materialize) or an
   *  explicitly-reasoned exemption — enforced by tests/sync-coverage.test.ts
   *  against the route files themselves, so a new endpoint without a registry
   *  entry fails the build. On top of that structural guard:
   *  (a) master/order updates carry a pre-edit base and the hub refuses stale
   *      replays instead of overwriting newer edits (P3b pattern);
   *  (b) ledger entries and cash movements are id-keyed appends that converge
   *      on redelivery — cash is never duplicated by a retry;
   *  (c) settlements serialize per party (the hub recomputes from live
   *      balance, so a concurrent loser would double-settle);
   *  (d) day-close is single-winner per date; closes are never auto-undone;
   *  (e) settings/company are hub-wins snapshots with convergence checks, and
   *      binary logo bytes stay device-local by explicit exemption.
   */
  const REPO = read(
    "src",
    "infrastructure",
    "repositories",
    "PostgresSyncResourceClaimRepository.ts",
  );
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const MAT = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const COV = read("src", "application", "use-cases", "sync", "syncCoverage.ts");

  it("master and order updates carry a stale-base guard", () => {
    expect(
      MAT.includes("baseVersion") && MAT.includes("stale base"),
      "hub must refuse stale master/order replays",
    ).toBe(true);
    expect(
      MAT.includes("intentAlreadyApplied"),
      "duplicate update deliveries must converge, not rewrite",
    ).toBe(true);
  });

  it("ledger and cash appends are id-keyed", () => {
    expect(
      MAT.includes("allExist") && MAT.includes("entryIds"),
      "ledger replay must converge per entry id",
    ).toBe(true);
    expect(
      MAT.includes("movementId") && MAT.includes("listManualMovements"),
      "movement replay must check existence by id",
    ).toBe(true);
  });

  it("settlements serialize per party and reverse by reference on loss", () => {
    expect(
      USECASES.includes('"settlement"') && USECASES.includes("already-settled balance"),
      "settlement must claim per party",
    ).toBe(true);
    expect(
      USECASES.includes('case "settlement"') && USECASES.includes("settlementRef"),
      "losing settlements must reverse locally by reference",
    ).toBe(true);
  });

  it("day-close is single-winner per date and never auto-undone", () => {
    expect(
      USECASES.includes("cashbox_close") && USECASES.includes("uuidFromString"),
      "close-date claims must be stable across devices",
    ).toBe(true);
    expect(
      MAT.includes("isDayLocked") && MAT.includes("closeDayUseCase"),
      "close replay must converge on locked days",
    ).toBe(true);
  });

  it("admin snapshots converge hub-wins and logo bytes are exempt", () => {
    expect(
      MAT.includes("materializeAdminSnapshot"),
      "settings/company must replay as snapshots",
    ).toBe(true);
    expect(
      COV.includes("POST /api/company/logo") && COV.includes("device-local"),
      "logo exemption must be explicit",
    ).toBe(true);
  });
});

describe("sync invariants — tombstone enforcement (plan §10)", () => {
  const MAT = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const DEPS = read("src", "application", "use-cases", "sync", "syncDependencySnapshots.ts");
  const SQL = allMigrationsSql();

  it("the migration creates sync_tombstones with forced tenant RLS", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+"?sync_tombstones"?/i);
    expect(SQL).toMatch(/sync_tombstones_tenant_isolation/i);
    expect(SQL).toMatch(/FORCE ROW LEVEL SECURITY/i);
    // a real tombstone must NEVER be cleared by a create — no naive rule
    // "if we find create we delete tombstone" (explicit non-goal §26 / §10).
    expect(SQL).not.toMatch(/DELETE FROM sync_tombstones/i);
  });

  it("a materialized master DELETE records a tombstone (delete + re-assert on retry)", () => {
    // The delete branch records the tombstone AFTER the row is gone, and the
    // idempotent `!hub` retry path re-asserts it so a crash between the two
    // never leaves a resurrectable hole.
    expect(MAT.includes("await recordTombstone("), "delete must record a tombstone").toBe(true);
    expect(
      MAT.includes("sync tombstone re-assert failed"),
      "the idempotent !hub retry must re-assert the tombstone",
    ).toBe(true);
    // provenance comes from the inbox row (opId/syncDeviceId), never the wire.
    expect(MAT.includes("meta?.opId")).toBe(true);
    expect(MAT.includes("SyncMaterializeMeta")).toBe(true);
  });

  it("a master CREATE is refused when a tombstone exists (no silent resurrection)", () => {
    expect(MAT.includes("await tombstoneExists("), "create must consult the tombstone").toBe(true);
    expect(
      MAT.includes("منع الاسترجاع"),
      "blocked recreation must surface a visible reason (in Arabic, not mojibake)",
    ).toBe(true);
  });

  it("dependency snapshots cannot resurrect tombstoned masters", () => {
    expect(
      DEPS.includes("syncTombstoneBlocksDependency"),
      "dependency ensure must export a tombstone guard",
    ).toBe(true);
    // all four master kinds are guarded in the insert-if-missing path.
    for (const t of ["party", "fabric", "color", "roll"]) {
      expect(DEPS.includes(`\"${t}\"`), `dependency guard must cover ${t}`).toBe(true);
    }
  });
});

describe("sync invariants — conflict tracking (plan §4/§11)", () => {
  const CONFLICTS = read("src", "application", "use-cases", "sync", "syncConflicts.ts");
  const MAT = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const UC = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const ROUTE = read("src", "presentation", "routes", "sync.route.ts");

  it("the migration creates sync_conflicts with per-op uniqueness and tenant RLS", () => {
    expect(allMigrationsSql()).toMatch(/CREATE TABLE IF NOT EXISTS\s+"?sync_conflicts"?/i);
    expect(allMigrationsSql()).toMatch(/sync_conflicts_tenant_isolation/i);
    expect(allMigrationsSql()).toMatch(/UNIQUE\s*\(tenant_id,\s*op_id\)/i);
  });

  it("recording is idempotent per (tenant, op_id) — one conflict row per loser op", () => {
    expect(
      CONFLICTS.includes("ON CONFLICT (tenant_id, op_id) DO NOTHING"),
      "first sighting of an op wins; retries are no-ops",
    ).toBe(true);
    expect(CONFLICTS.includes("recordSyncConflict")).toBe(true);
  });

  it("records who lost, on which document, with base and server versions", () => {
    expect(CONFLICTS.includes("base_version")).toBe(true);
    expect(CONFLICTS.includes("server_version")).toBe(true);
    expect(CONFLICTS.includes("op_id")).toBe(true);
  });

  it("resolution is explicit, never a blind LWW overwrite", () => {
    expect(
      CONFLICTS.includes('"keep-server"') && CONFLICTS.includes('"rebase"') &&
        CONFLICTS.includes('"withdraw"'),
      "operator chooses the outcome; nothing auto-applies the loser's intent",
    ).toBe(true);
  });

  it("stale-base update materialization records the concurrent-edit loss", () => {
    expect(MAT.includes("recordStaleConflict"), "materializers must record stale-base").toBe(
      true,
    );
    expect(MAT.includes('"invoice"') && MAT.includes('"order"')).toBe(true);
    expect(MAT.includes("recordSyncConflict")).toBe(true);
  });

  it("a claim-conflict loser is tracked, and an applied unit clears its open conflict", () => {
    expect(UC.includes("recordSyncConflict"), "claim loser must enter the ledger").toBe(true);
    expect(UC.includes("resolveSyncConflictByOp"), "applied unit must close open conflict").toBe(
      true,
    );
  });

  it("conflicts surface to the operator via GET and POST endpoints", () => {
    expect(ROUTE.includes('"/sync/conflicts"'), "list endpoint").toBe(true);
    expect(ROUTE.includes('"/sync/conflicts/resolve"'), "resolve endpoint").toBe(true);
  });
});

describe("sync invariants — registered-device transport gate", () => {
  /**
   * THE INVARIANTS:
   *  Device identity is self-asserted (header/body), so the hub treats an
   *  asserted id as a claim, not a fact: pushes from ids the tenant never
   *  registered are refused BEFORE any inbox/claim/materialize work (nothing
   *  to triage, nothing to roll back). The device, in turn, must never treat
   *  that refusal as content rejection — the unit stays pending and the run
   *  reports deviceGate for a register-device prompt. Actor identity was
   *  already hub-side (replayCtxFromPayload ignores payload actors).
   */
  const ROUTE = read("src", "presentation", "routes", "sync.route.ts");
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  // Batch 4 / 4B: the gate itself now lives in one shared middleware and is
  // applied per route, so the invariant is asserted at BOTH ends — the gate
  // refuses an unregistered device, and the route applies the gate before the
  // push handler runs.
  const GATE = read(
    "src",
    "infrastructure",
    "http",
    "middleware",
    "sync-device-gate.middleware.ts",
  );

  it("hub refuses unregistered device pushes pre-work", () => {
    expect(
      GATE.includes("SYNC_UNKNOWN_DEVICE") && GATE.includes("syncDeviceRepo.findById"),
      "the device gate must resolve registration before any work",
    ).toBe(true);
    // Ordering, not just presence: the gate must be mounted on the push route
    // and must appear BEFORE the unit is received.
    const pushIdx = ROUTE.indexOf('"/sync/push"');
    const gateOnPush = ROUTE.indexOf("gate.attributed", pushIdx);
    const receiveIdx = ROUTE.indexOf("receiveSyncPush(");
    expect(pushIdx, "push route must exist").toBeGreaterThan(-1);
    expect(gateOnPush, "push route must mount the device gate").toBeGreaterThan(pushIdx);
    expect(gateOnPush, "the gate must run before receiveSyncPush").toBeLessThan(receiveIdx);
  });

  it("a gate refusal never rolls back local documents", () => {
    expect(
      USECASES.includes("DEVICE_TRUST_CODES") &&
        USECASES.includes("must NOT mark the unit rejected"),
      "403 must reset to pending with deviceGate, never markRejected",
    ).toBe(true);
    // Every device-trust refusal must be inside the same non-destructive
    // branch: the code set is what the pusher checks, so a new refusal code
    // cannot be added without landing in it.
    expect(
      /if \(res\.status === 403 && parsed\.code && DEVICE_TRUST_CODES\.has\(parsed\.code\)\)/.test(
        USECASES,
      ),
      "the branch must key on the shared device-trust code set",
    ).toBe(true);
    expect(
      /const DEVICE_TRUST_CODES = new Set\(\[[\s\S]*?"SYNC_UNKNOWN_DEVICE"[\s\S]*?"SYNC_DEVICE_REVOKED"[\s\S]*?"SYNC_DEVICE_NOT_BOUND"[\s\S]*?"SYNC_DEVICE_FINGERPRINT_MISMATCH"/.test(
        USECASES,
      ),
      "revoked / not-bound / mismatched device ids are device-trust refusals",
    ).toBe(true);
  });

  it("registration binds the asserted UUID", () => {
    expect(
      USECASES.includes("deviceGate: boolean") && USECASES.includes("deviceGate = true"),
      "the run result must carry the gate flag to the UI",
    ).toBe(true);
  });
});

describe("sync invariants — cancel replay honours optimistic concurrency", () => {
  /**
   * THE INVARIANTS:
   *  A cancel is a financial mutation, so it must obey the same optimistic
   *  concurrency contract as an update: the device stamps the version its
   *  cancel was validated against, and the hub REFUSES (retryable, recorded in
   *  sync_conflicts) a cancel whose base is stale instead of voiding a newer
   *  edit made by another device. Before this guard, `materialize*Cancel`
   *  fell back to `existing.version` and applied blind — a silent last-write-
   *  wins kill of a concurrent edit, the exact convergence failure §4 forbids.
   */
  const ENQ = read("src", "application", "use-cases", "sync", "syncEnqueue.ts");
  const MAT = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  const ROUTES = [
    ["invoice", read("src", "presentation", "routes", "invoice.route.ts"), "enqueueInvoiceCancel"],
    ["voucher", read("src", "presentation", "routes", "voucher.route.ts"), "enqueueVoucherCancel"],
    ["return", read("src", "presentation", "routes", "return.route.ts"), "enqueueReturnCancel"],
    ["order", read("src", "presentation", "routes", "order.route.ts"), "enqueueOrderCancel"],
    ["expense", read("src", "presentation", "routes", "expense.route.ts"), "enqueueExpenseCancel"],
  ] as const;

  it("every cancel enqueue writes a baseVersion into the sync payload", () => {
    const stamps = ENQ.split("baseVersion: baseVersion ?? null").length - 1;
    expect(
      stamps,
      "all five cancel enqueues (invoice/voucher/return/order/expense) must carry the base version",
    ).toBeGreaterThanOrEqual(5);
    for (const name of [
      "enqueueInvoiceCancel",
      "enqueueVoucherCancel",
      "enqueueReturnCancel",
      "enqueueOrderCancel",
      "enqueueExpenseCancel",
    ]) {
      const body = ENQ.slice(ENQ.indexOf(`export async function ${name}(`));
      expect(body.slice(0, 1400).includes("baseVersion"), `${name} must accept a baseVersion`).toBe(
        true,
      );
    }
  });

  it("every cancel materializer refuses a stale base and records the conflict", () => {
    // one definition + one call per document type (5)
    expect(
      MAT.split("refuseStaleCancelBase(").length - 1,
      "the shared stale-base guard must be defined once and used by all five cancels",
    ).toBeGreaterThanOrEqual(6);
    const guard = MAT.slice(MAT.indexOf("async function refuseStaleCancelBase("));
    expect(guard.slice(0, 2600).includes('"cancel"'), "a refused cancel is a cancel conflict").toBe(
      true,
    );
    expect(
      guard.slice(0, 2600).includes("recordStaleConflict"),
      "a refused cancel must be recorded for the operator",
    ).toBe(true);
    // the fallback to existing.version is only for hubCanonical / already-guarded paths
    for (const at of ["Order", "Voucher", "Return", "Expense", "Invoice"]) {
      const fn = MAT.slice(MAT.indexOf(`async function materialize${at}Cancel(`));
      const body = fn.slice(0, 2600);
      expect(body.includes("refuseStaleCancelBase("), `${at} cancel must consult the guard`).toBe(
        true,
      );
      const guardAt = body.indexOf("refuseStaleCancelBase(");
      const applyAt = body.indexOf("const result = await cancel");
      expect(guardAt, `${at} cancel must guard BEFORE applying`).toBeLessThan(
        applyAt === -1 ? body.length : applyAt,
      );
    }
    expect(
      guard.slice(0, 3200).includes("baseVersion === null"),
      "missing baseVersion on cancel must be refused (no blind apply)",
    ).toBe(true);
  });

  it("cancel routes stamp the version they validated locally", () => {
    for (const [label, source, enqueueName] of ROUTES) {
      expect(source.includes(enqueueName), `${label} route must enqueue its cancel`).toBe(true);
      const callAt = source.indexOf(`${enqueueName}(`);
      expect(callAt, `${label} cancel enqueue must exist`).toBeGreaterThan(-1);
      expect(
        source.slice(callAt, callAt + 500).includes("expectedVersion"),
        `${label} cancel must pass the locally validated version to the hub`,
      ).toBe(true);
    }
  });
});

describe("sync invariants — bounded push lanes (SYNC-16)", () => {
  /**
   * THE INVARIANTS:
   *  The push batch is partitioned by document key so units for the SAME
   *  document keep recorded order in one lane (create → update → cancel can
   *  never overtake), while independent documents drain concurrently — a unit
   *  stuck on hub retries no longer head-of-line-blocks the batch.
   *  Cross-document push order was never a business invariant: dependencies
   *  converge hub-side via ensureDeps deferral, and numbers are pre-allocated.
   */
  const USECASES = read("src", "application", "use-cases", "sync", "syncUseCases.ts");

  it("lanes partition by document key with per-lane order", () => {
    expect(
      USECASES.includes("laneOf") && USECASES.includes("entityType}:${entityId"),
      "lane key must be the document identity",
    ).toBe(true);
    expect(
      USECASES.includes("PUSH_LANES") && USECASES.includes("Promise.all"),
      "lanes must drain concurrently and bounded",
    ).toBe(true);
    expect(
      USECASES.includes("ORDERED_LANE_TYPES") && USECASES.includes('"roll"'),
      "order-sensitive types (masters/ledger/settlement/cashbox) must keep recorded order in lane 0",
    ).toBe(true);
  });
});

describe("sync invariants — number-block tip reconciliation", () => {
  /**
   * THE INVARIANTS (reproduced live in the drills: fallback-issued
   * CUS-2026-0001 collided with hub-claimed [1..500]):
   *  (a) A hub block claim carries the device's fallback-issued tip
   *      (knownUsed) and the hub advances its own tip past it BEFORE carving,
   *      so carved ranges never overlap numbers already in the wild.
   *  (b) After mirroring a hub block, the device advances its LOCAL tip past
   *      the mirrored range, so a later local claim (hub unreachable) cannot
   *      overlap it either.
   */
  const NB = read("src", "application", "use-cases", "sync", "numberBlockUseCases.ts");
  const ROUTE = read("src", "presentation", "routes", "sync.route.ts");

  it("hub advances its tip past knownUsed before carving", () => {
    expect(
      NB.includes("knownUsed") && NB.includes("GREATEST"),
      "claim must reconcile the tip with GREATEST",
    ).toBe(true);
    expect(ROUTE.includes("knownUsed"), "the claim endpoint must accept knownUsed").toBe(true);
  });

  it("mirroring advances the local tip past the hub range", () => {
    expect(NB.includes("advanceLocalSequenceTip"), "mirror must advance the local tip").toBe(true);
    expect(NB.includes("readLocalSequenceTip"), "the device must report its fallback tip").toBe(
      true,
    );
  });
});

describe("P3 consolidation contracts", () => {
  const NUMBERS = read("src", "infrastructure", "utils", "documentNumbers.ts");
  const HTTP_IDEMPOTENCY = read("src", "infrastructure", "http", "middleware", "idempotency.middleware.ts");
  const RUNBOOK = readFileSync(join(BACKEND_ROOT, "..", "docs", "SYNC-OPERATIONS.md"), "utf8");
  const PLAN = readFileSync(join(BACKEND_ROOT, "..", "MOTARD-COMPLETE-REMEDIATION-PLAN.md"), "utf8");

  it("documents block authority and explicit global fallback", () => {
    expect(NUMBERS).toContain("documentNumberBlocks");
    expect(NUMBERS).toContain("allowGlobalFallback");
    expect(NUMBERS).toContain("Financial documents deliberately do NOT set this");
    expect(RUNBOOK).toContain("canonical");
  });

  it("keeps HTTP and sync idempotency scopes non-overlapping", () => {
    expect(HTTP_IDEMPOTENCY).toContain("HTTP retry guard only");
    expect(HTTP_IDEMPOTENCY).toContain("(tenant_id, op_id)");
    expect(RUNBOOK).toContain("Sync retries");
    expect(RUNBOOK).toContain("five minutes");
  });

  it("uses the remediation plan as current P3 tracking", () => {
    expect(PLAN).toContain("P3-1");
    expect(PLAN).toContain("P3-2");
    expect(PLAN).toContain("P3-3");
    expect(PLAN).toContain("no runtime PASS claim");
  });
});
