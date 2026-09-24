import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { Container } from "../../infrastructure/di/container.js";
import * as syncUc from "../../application/use-cases/sync/syncUseCases.js";
import * as syncConflicts from "../../application/use-cases/sync/syncConflicts.js";
import * as numberBlocksUc from "../../application/use-cases/sync/numberBlockUseCases.js";
import { logger } from "../../infrastructure/config/logger.js";
import { BusinessRuleError } from "../../domain/errors/index.js";
import {
  connectHub,
  disconnectHub,
  getCentralSyncUrl,
  getHubSessionInfo,
  isHubReachableCached,
  listHubActivity,
  loadHubCredentials,
  resolveConnectCredentials,
  pairHubSession,
  probeHubReachable,
  pullHubActivity,
  recordHubActivity,
  setRuntimeCentralSyncUrl,
  testHubConnection,
} from "../../application/use-cases/sync/hubConfig.js";
import { describeHubActivity, describePulledUnit } from "../../application/use-cases/sync/syncActivity.js";
import { revokeSubjectSessions } from "../../infrastructure/auth/sessionCutoff.js";

const HubConfigSchema = z.object({
  url: z.string().url().nullable(),
});

const HubPairSchema = z.object({
  url: z.string().url(),
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
  userId: z.string().uuid().optional(),
  pin: z.string().min(4).max(12).optional(),
  tenantId: z.string().uuid().optional(),
});

const HubTestSchema = z.object({
  url: z.string().url().optional(),
});

const HubConnectSchema = z.object({
  url: z.string().url(),
  // Both optional when this device already holds the hub account (stored
  // encrypted at pairing): changing only the URL — e.g. a tunnel that got a
  // new address — must not force the operator to type the password again.
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
});

const HubActivitySchema = z.object({
  kind: z.literal("login"),
  userName: z.string().min(1).max(120),
  userRole: z.string().max(20).nullable().optional(),
  deviceLabel: z.string().max(120).nullable().optional(),
  sourceDeviceId: z.string().uuid().nullable().optional(),
});

const PushUnitSchema = z.object({
  opId: z.string().uuid(),
  syncDeviceId: z.string().uuid().nullable().optional(),
  entityType: z.string().min(1).max(40),
  entityId: z.string().uuid(),
  operation: z.string().min(1).max(20),
  payload: z.record(z.unknown()),
});

const ClaimBlockSchema = z.object({
  syncDeviceId: z.string().uuid(),
  entityType: z.string().min(1).max(30),
  size: z.number().int().min(1).max(5000).optional(),
  // Tip reconciliation: highest number the claiming device already issued
  // via local fallback. The hub advances its tip past it before carving.
  knownUsed: z.number().int().min(0).max(999999).optional(),
});

const EnsureBlocksSchema = z.object({
  syncDeviceId: z.string().uuid(),
  entityTypes: z.array(z.string().min(1).max(30)).optional(),
});

const ReclaimBlockSchema = z.object({
  blockId: z.string().uuid(),
});

const RevokeDeviceSchema = z.object({
  /** Operator reason, recorded verbatim on the device row for the audit trail. */
  reason: z.string().trim().min(1).max(64).optional(),
});

/**
 * Batch 4 / item 4A — role matrix for the sync surface.
 *
 * The guards are injected (same shape as every other route module in the
 * project: `registerXRoutes(router, repo, auth, writeGuard, readGuard, …)`) so
 * the matrix stays visible at the registration site in server.ts.
 *
 * Two families exist because the sync surface is NOT a normal CRUD surface:
 *
 *  - TRANSPORT (`/sync/push`, `/sync/pull`, `/sync/run`): this is the device
 *    moving work that a route guard ALREADY authorized locally when the user
 *    created the document. Pushing is not a re-authorization of that action —
 *    the unit carries the ORIGINAL actor (`replayCtxFromPayload`) — so
 *    restricting it by the pusher's role would break the offline flow of every
 *    shared workstation (a `viewer`/`warehouse` session flushing an
 *    accountant's queued invoice would get a 403 and the queue would never
 *    drain). Authority on this path is DEVICE trust, enforced by
 *    `sync-device-gate.middleware.ts`, not role. All four roles therefore keep
 *    the transport endpoints, exactly as before this batch.
 *
 *  - OPERATOR (`/sync/claims/reap`, `/sync/conflicts/resolve`,
 *    `/sync/number-blocks/*`, `/sync/devices/*`): these mutate sync
 *    bookkeeping, mint document-number authority, or record a resolution
 *    decision about documents. They follow the project's existing
 *    classifications: repairs/administration are `admin` (settings, users,
 *    license, backup are admin-only), document-number and conflict decisions
 *    need an operational role and exclude the read-only `viewer` (viewer is
 *    never in a write guard anywhere in this codebase).
 */
export type SyncRouteGuards = {
  /** Read-only sync diagnostics: every authenticated role (as dashboard/audit). */
  readGuard: RequestHandler;
  /** Device transport: writers only on hub ingest; local run uses this too. */
  transportGuard: RequestHandler;
  /** Number-block minting/ensuring: operational roles, viewer excluded. */
  numberingGuard: RequestHandler;
  /** Conflict resolution + device management decisions. */
  conflictGuard: RequestHandler;
  /** Repairs and device lifecycle: admin only. */
  operatorGuard: RequestHandler;
};

/**
 * Device-trust gates, pre-configured with their policy (see
 * sync-device-gate.middleware.ts):
 *  - `attributed`: the asserted device must be registered, not revoked and
 *    bound to the caller. Hub ingestion / device-scoped number blocks.
 *  - `pull`: same, but the `excludeSyncDeviceId` query parameter counts as the
 *    caller asserting its own device (that is how the hub pull path carries
 *    device identity today).
 *  - `orchestration`: local `/sync/run` trigger. An unregistered local device
 *    is a supported state (per-unit gating still happens at the hub), but a
 *    REVOKED device is refused immediately and explicitly.
 */
export type SyncDeviceGates = {
  attributed: RequestHandler;
  pull: RequestHandler;
  orchestration: RequestHandler;
};

export function registerSyncRoutes(
  router: Router,
  container: Container,
  auth: RequestHandler,
  guards: SyncRouteGuards,
  gate: SyncDeviceGates,
) {
  router.get("/sync/hub-config", auth, guards.readGuard, async (_req: Request, res: Response) => {
    const url = getCentralSyncUrl();
    const reachable = await probeHubReachable();
    res.json({ url, hubReachable: url ? reachable : null });
  });

  router.put(
    "/sync/hub-config",
    auth,
    guards.operatorGuard,
    validateBody(HubConfigSchema),
    async (req: Request, res: Response) => {
      const body = (req as unknown as { validatedBody: z.infer<typeof HubConfigSchema> })
        .validatedBody;
      const url = setRuntimeCentralSyncUrl(body.url);
      res.json({ url, hubReachable: url ? await probeHubReachable(true) : null });
    },
  );

  router.post(
    "/sync/hub-pair",
    auth,
    guards.operatorGuard,
    validateBody(HubPairSchema),
    async (req: Request, res: Response) => {
      const body = (req as unknown as { validatedBody: z.infer<typeof HubPairSchema> }).validatedBody;
      const ctx = req.tenantContext!;
      const result = await pairHubSession({
        ...body,
        tenantId: body.tenantId ?? ctx.tenantId,
      });
      if (!result.ok) {
        res.status(422).json({ code: "HUB_PAIR_FAILED", message: result.error });
        return;
      }
      res.json({ url: result.url, paired: true });
    },
  );

  // ── Settings → «المزامنة السحابية» — admin only ────────────────────────────
  // The pre-auth pairing surface on the login screen is gone: pairing decides
  // where every document of this device is sent, so it needs an admin session.

  router.get("/sync/hub", auth, guards.operatorGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const url = getCentralSyncUrl();
    const reachable = url ? await probeHubReachable() : null;
    const status = await syncUc.getSyncStatus(container.syncOutboxRepo, ctx.tenantId);
    // Honest health: "connected" is meaningless if work is not leaving this
    // device. Report how long the oldest unsent unit has waited and why the
    // last attempt failed, so the screen can show a problem instead of green.
    const { pool } = await import("../../infrastructure/orm/drizzle.js");
    const health = await pool
      .query(
        // The reason shown is the one of the unit that BLOCKS the queue: units
        // queued behind it only say "waiting for an earlier operation", which
        // tells the operator nothing.
        `SELECT min(created_at) AS oldest,
                (array_agg(error_detail ORDER BY seq ASC)
                   FILTER (WHERE error_detail IS NOT NULL AND error_detail <> $2))[1] AS last_error,
                bool_or(error_detail = $2) AS has_waiting
           FROM sync_outbox WHERE tenant_id = $1 AND status IN ('pending', 'pushing')`,
        [ctx.tenantId, syncUc.ORDERED_LANE_WAITING],
      )
      .then((r) => r.rows[0] ?? {})
      .catch(() => ({}));
    res.json({
      url,
      reachable,
      session: getHubSessionInfo(),
      hasStoredCredentials: loadHubCredentials() !== null,
      oldestPendingAt: health.oldest ? new Date(health.oldest).toISOString() : null,
      lastPushError: health.last_error ?? (health.has_waiting ? syncUc.ORDERED_LANE_WAITING : null),
      pendingCount: status.pendingCount,
      statusCounts: status.statusCounts,
      lastPullAt: status.lastPullAt,
      localDeviceId: ctx.syncDeviceId ?? null,
    });
  });

  router.post(
    "/sync/hub/test",
    auth,
    guards.operatorGuard,
    validateBody(HubTestSchema),
    async (req: Request, res: Response) => {
      const body = (req as unknown as { validatedBody: z.infer<typeof HubTestSchema> }).validatedBody;
      const url = body.url ?? getCentralSyncUrl();
      if (!url) {
        res.status(422).json({ code: "HUB_NOT_CONFIGURED", message: "لم يُحدَّد رابط المركز" });
        return;
      }
      res.json(await testHubConnection(url));
    },
  );

  router.post(
    "/sync/hub/connect",
    auth,
    guards.operatorGuard,
    validateBody(HubConnectSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof HubConnectSchema> })
        .validatedBody;
      const localDevice = ctx.syncDeviceId
        ? await container.syncDeviceRepo.findById(ctx.tenantId, ctx.syncDeviceId).catch(() => null)
        : null;
      const { email, password } = resolveConnectCredentials(body);
      if (!email || !password) {
        res.status(422).json({
          code: "HUB_CONNECT_FAILED",
          stage: "login",
          message: "أدخل البريد وكلمة مرور حساب المركز (لا يوجد حساب محفوظ على هذا الجهاز)",
        });
        return;
      }
      const result = await connectHub({
        url: body.url,
        email,
        password,
        device: localDevice
          ? {
              id: localDevice.id,
              fingerprint: localDevice.deviceFingerprint,
              fingerprintVersion: localDevice.deviceFingerprintVersion,
              platform: localDevice.platform,
              hostname: localDevice.hostname,
              label: localDevice.label,
            }
          : null,
      });
      if (!result.ok) {
        res
          .status(422)
          .json({ code: "HUB_CONNECT_FAILED", stage: result.stage, message: result.error });
        return;
      }
      // A different hub (or hub tenant) has its own received_seq sequence.
      // A different hub (or hub company) knows nothing this device already
      // delivered elsewhere: re-pull from its start AND re-deliver our own
      // history — otherwise moving to a new server (test tunnel → real hub)
      // silently leaves every earlier customer, roll and invoice behind, and
      // later units then fail against missing parents.
      let requeued = 0;
      if (result.hubChanged) {
        await syncUc.resetPullCursor(ctx.tenantId);
        requeued = await container.syncOutboxRepo.requeueSyncedForNewHub(ctx.tenantId);
      }
      // Paired = several writers: reserve this device's number ranges from the
      // hub NOW, so the very first document after pairing cannot collide.
      let blocksError: string | null = null;
      if (ctx.syncDeviceId) {
        await numberBlocksUc
          .ensureDeviceNumberBlocks(container.documentNumberBlockRepo, container.fingerprintProvider, {
            tenantId: ctx.tenantId,
            syncDeviceId: ctx.syncDeviceId,
            userId: ctx.userId,
            authHeader: req.headers.authorization,
          })
          .catch((err) => {
            blocksError = err instanceof Error ? err.message : String(err);
          });
      }
      res.json({
        url: result.info.hubUrl,
        session: result.info,
        cursorReset: result.hubChanged,
        requeued,
        blocksError,
        deviceWarning: result.deviceWarning,
      });
    },
  );

  router.delete("/sync/hub", auth, guards.operatorGuard, async (_req: Request, res: Response) => {
    disconnectHub();
    res.json({ url: null, session: null });
  });

  // Hub side of the presence feed: a paired device reports «user X logged in»,
  // peers read it during /sync/run. Ephemeral (in-memory) by design.
  router.post(
    "/sync/activity",
    auth,
    guards.readGuard,
    validateBody(HubActivitySchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof HubActivitySchema> })
        .validatedBody;
      const row = recordHubActivity(ctx.tenantId, {
        kind: body.kind,
        userName: body.userName,
        userRole: body.userRole ?? null,
        deviceLabel: body.deviceLabel ?? null,
        sourceDeviceId: body.sourceDeviceId ?? null,
      });
      res.status(201).json(row);
    },
  );

  router.get("/sync/activity", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const raw = typeof req.query.afterSeq === "string" ? Number(req.query.afterSeq) : NaN;
    const afterSeq = Number.isFinite(raw) && raw >= 0 ? raw : null;
    res.json({ items: listHubActivity(ctx.tenantId, afterSeq) });
  });

  router.get("/sync/status", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const status = await syncUc.getSyncStatus(container.syncOutboxRepo, ctx.tenantId);

    // Inbound side (hub role): a unit that failed to materialize used to be
    // invisible — neither `applied` (so peers never pulled it) nor surfaced
    // anywhere. Report the breakdown so "stuck" is observable.
    const inboxStatusCounts = await container.syncInboxRepo.countByStatus(ctx.tenantId);

    // Number-block health (F-10): a device with no active block mints codes
    // from its own local sequence, which can collide with another node's codes
    // on the hub. Surfacing it here turns a silent degradation into something
    // an operator can see and fix by syncing once.
    let numberBlocks: Array<{
      entityType: string;
      year: number;
      startNumber: number;
      endNumber: number;
      nextNumber: number;
      status: string;
    }> = [];
    if (ctx.syncDeviceId) {
      try {
        const rows = await container.documentNumberBlockRepo.listForDevice(
          ctx.tenantId,
          ctx.syncDeviceId,
        );
        numberBlocks = rows.map((r) => ({
          entityType: r.entityType,
          year: r.year,
          startNumber: r.startNumber,
          endNumber: r.endNumber,
          nextNumber: r.nextNumber,
          status: r.status,
        }));
      } catch (err) {
        logger.warn({ err }, "number-block status read failed");
      }
    }
    const blockEntityTypes = new Set(numberBlocks.map((b) => b.entityType));
    // P4: every auto-provisioned type is health-checked, not just the original
    // four — an expired/exhausted block for vouchers, returns, expenses or
    // orders fails loud on next create, so it must be visible here first.
    const missingBlocks = [
      "customer",
      "supplier",
      "invoice",
      "invoice_entry",
      "voucher",
      "return",
      "expense",
      "order",
    ].filter((t) => !blockEntityTypes.has(t));

    // P1-step-1: outstanding first-write-wins claims, each joined with its
    // holder op's hub inbox status so a stranded claim (dead holder) is
    // distinguishable from a live reservation. Best-effort like the block
    // read above: observability must never fail the status call itself.
    let claimInventory: syncUc.SyncClaimInventory | null = null;
    try {
      claimInventory = await syncUc.getSyncClaimInventory(
        container.syncInboxRepo,
        container.syncResourceClaimRepo,
        ctx.tenantId,
      );
    } catch (err) {
      logger.warn({ err }, "sync claim inventory read failed");
    }

    res.json({ ...status, inboxStatusCounts, numberBlocks, missingBlocks, claimInventory });
  });

  /**
   * Operational visibility: the units that are NOT moving — rejected by a
   * conflict, or parked as `dead` after their materialization attempts were
   * exhausted. Without this endpoint a stuck unit is invisible to the operator.
   */
  router.get("/sync/inbox", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const statusParam = typeof req.query.status === "string" ? req.query.status : "";
    const allowed: Array<"received" | "applied" | "rejected" | "dead"> = [
      "received",
      "applied",
      "rejected",
      "dead",
    ];
    const statuses = statusParam
      ? allowed.filter((s) => statusParam.split(",").includes(s))
      : (["rejected", "dead", "received"] as const);
    const rows = await container.syncInboxRepo.listByStatus(ctx.tenantId, [...statuses], 200);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        opId: r.opId,
        entityType: r.entityType,
        entityId: r.entityId,
        operation: r.operation,
        status: r.status,
        syncDeviceId: r.syncDeviceId,
        rejectReason: r.rejectReason,
        conflictOpId: r.conflictOpId,
        materializeError: r.materializeError,
        applyAttempts: r.applyAttempts,
        lastAttemptAt: r.lastAttemptAt,
        receivedSeq: r.receivedSeq,
        receivedAt: r.receivedAt,
        appliedAt: r.appliedAt,
      })),
    });
  });

  router.get("/sync/pending", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    // Claimable, not just `pending`: units stranded in `pushing` by a crashed
    // run are still outstanding work and must be visible here.
    const rows = await container.syncOutboxRepo.listClaimable(ctx.tenantId, 100);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        opId: r.opId,
        entityType: r.entityType,
        entityId: r.entityId,
        operation: r.operation,
        status: r.status,
        seq: r.seq,
        createdAt: r.createdAt,
      })),
    });
  });

  /**
   * P1-step-1: dedicated claim inventory (same payload as the `claimInventory`
   * section of `/sync/status`, without the unrelated counts).
   */
  router.get("/sync/claims", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const inventory = await syncUc.getSyncClaimInventory(
      container.syncInboxRepo,
      container.syncResourceClaimRepo,
      ctx.tenantId,
    );
    res.json(inventory);
  });

  /**
   * P1-step-1: release claims whose holder op reached the terminal `dead`
   * state. Terminal-gated by construction (see `reapTerminalSyncClaims`):
   * live reservations are reported as `kept` and never deleted.
   */
  router.post("/sync/claims/reap", auth, guards.operatorGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    try {
      const result = await syncUc.reapTerminalSyncClaims(
        container.syncInboxRepo,
        container.syncResourceClaimRepo,
        ctx.tenantId,
      );
      logger.info(
        { tenantId: ctx.tenantId, userId: ctx.userId, ...result },
        "operator reaped dead sync-unit claims",
      );
      res.json(result);
    } catch (err) {
      logger.error({ err }, "sync claim reap failed");
      res.status(500).json({ code: "SYNC_CLAIM_REAP_FAILED", message: "فشل تحرير المطالبات" });
    }
  });
/**
   * Conflict tracking (plan §4/§11): open update/cancel conflicts that lost on
   * optimistic concurrency, each carrying the loser op, the base version they
   * started from, and the server version that actually won. Unresolved by
   * default — an operator decides, never a silent LWW.
   */
  router.get("/sync/conflicts", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const all = req.query.all === "1" || req.query.all === "true";
    const conflicts = await syncConflicts.listSyncConflicts(ctx.tenantId, { openOnly: !all });
    res.json({ items: conflicts });
  });

  const ResolveConflictSchema = z.object({
    conflictId: z.string().uuid(),
    decision: z.enum(["keep-server", "rebase", "withdraw"]),
    note: z.string().max(2000).optional(),
  });

  /**
   * Explicit conflict resolution — no blind overwrite. The operator records a
   * decision (keep-server / rebase / withdraw). For `rebase`, the response's
   * `serverVersion` is the version a legitimate re-submission of the losing
   * local intent must be based on; the actual re-submit goes through the
   * normal update path so it is a NEW edit, never an overwrite.
   */
  router.post(
    "/sync/conflicts/resolve",
    auth,
    guards.conflictGuard,
    validateBody(ResolveConflictSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof ResolveConflictSchema> })
        .validatedBody;
      const resolved = await syncConflicts.resolveSyncConflict(
        ctx.tenantId,
        body.conflictId,
        body.decision,
        ctx.userId,
        body.note,
      );
      if (!resolved) {
        res.status(409).json({
          code: "SYNC_CONFLICT_NOT_OPEN",
          message: "التعارض غير موجود أو حُلَّ سابقاً",
        });
        return;
      }
      logger.info(
        { conflictId: body.conflictId, decision: body.decision, byUserId: ctx.userId },
        "operator resolved sync conflict",
      );
      res.json({ resolved });
    },
  );

  /** Push local outbox to hub, then pull peers' applied units. */

  /** Push local outbox to hub, then pull peers' applied units. */
  router.post(
    "/sync/run",
    auth,
    guards.transportGuard,
    gate.orchestration,
    async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    // REPAIR-007: per-tenant run lock on a dedicated client (held for the whole run).
    const { pool } = await import("../../infrastructure/orm/drizzle.js");
    const lockClient = await pool.connect();
    let lockHeld = false;
    try {
      const lockKey = `${ctx.tenantId}:sync-run`;
      const lockRes = await lockClient.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
        [lockKey],
      );
      lockHeld = Boolean(lockRes.rows[0]?.ok);
      if (!lockHeld) {
        res.json({ skipped: true, reason: "sync already running" });
        return;
      }

    // One claim batch is 50 units. A device with history (worked standalone,
    // or restored data) can hold thousands: pushing one batch per run left
    // them trickling for hours. Keep draining full, clean batches within a
    // time budget; any failure, device refusal or short batch ends the loop.
    const pushOnce = () =>
      syncUc.runLocalSyncPush(
        container.syncOutboxRepo,
        container.invoiceRepo,
        container.auditRepo,
        container.notificationRepo,
        ctx,
        req.headers.authorization,
        // P1-step-1: every created document type needs its cancel use-case wired
        // so a terminally-rejected unit rolls back locally instead of forking.
        {
          voucherRepo: container.voucherRepo,
          returnRepo: container.returnRepo,
          orderRepo: container.orderRepo,
          expenseRepo: container.expenseRepo,
          ledgerRepo: container.ledgerRepo,
          cashboxRepo: container.cashboxRepo,
        },
      );
    const PUSH_BATCH = 50; // claimBatch size in runLocalSyncPush
    const handledOf = (r: { pushed: number; failed: number; rejected: number; hubDead: number }) =>
      r.pushed + r.failed + r.rejected + r.hubDead;
    const push = await pushOnce();
    const pushDeadline = Date.now() + 30_000;
    let lastFull = handledOf(push) >= PUSH_BATCH;
    while (lastFull && !push.deviceGate && push.failed === 0 && Date.now() < pushDeadline) {
      const more = await pushOnce();
      push.pushed += more.pushed;
      push.failed += more.failed;
      push.rejected += more.rejected;
      push.hubDead += more.hubDead;
      push.hubDeadOps.push(...more.hubDeadOps);
      push.deviceGate ||= more.deviceGate;
      push.deviceTrust ??= more.deviceTrust;
      lastFull = handledOf(more) >= PUSH_BATCH;
    }

    let pull: Awaited<ReturnType<typeof syncUc.runLocalSyncPull>> = {
      pulled: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      deviceTrust: null,
    };
    // P7: a failed pull must be VISIBLE in the run result. The old shape
    // swallowed the error and returned zeros, which reads exactly like "in
    // sync, nothing to do" — an operator cannot distinguish success from a
    // hub outage. Same for the best-effort block refill below.
    let pullError: string | null = null;
    try {
      // Same drain as push: a hub page is 50 units. Keep pulling full pages
      // that made progress, within a budget (a stuck page — held units, a
      // failure — ends the loop; the next run resumes from the cursor).
      const pullOnce = () =>
        syncUc.runLocalSyncPull(
          container.db,
          {
            invoiceRepo: container.invoiceRepo,
            voucherRepo: container.voucherRepo,
            returnRepo: container.returnRepo,
            orderRepo: container.orderRepo,
            expenseRepo: container.expenseRepo,
            auditRepo: container.auditRepo,
            partyRepo: container.partyRepo,
            fabricRepo: container.fabricRepo,
            colorRepo: container.colorRepo,
            rollRepo: container.rollRepo,
            ledgerRepo: container.ledgerRepo,
            statementRepo: container.statementRepo,
            printJobRepo: container.printJobRepo,
            cashboxRepo: container.cashboxRepo,
            settingsRepo: container.settingsRepo,
            companyRepo: container.companyRepo,
          },
          ctx,
          req.headers.authorization,
          ctx.syncDeviceId ?? null,
          // Local inbox: mirrors pulled units so their retries are bounded and a
          // permanently-failing unit cannot hold the cursor forever.
          container.syncInboxRepo,
          // Activity notifications for work done on other devices.
          async (unit) => {
            const n = describePulledUnit(unit);
            if (n) await container.notificationRepo.create(n, ctx);
          },
        );
      pull = await pullOnce();
      const pullDeadline = Date.now() + 30_000;
      let page = pull;
      while (
        page.pulled >= 50 &&
        page.applied + page.skipped > 0 &&
        page.failed === 0 &&
        !page.deviceTrust &&
        Date.now() < pullDeadline
      ) {
        page = await pullOnce();
        pull = {
          pulled: pull.pulled + page.pulled,
          applied: pull.applied + page.applied,
          skipped: pull.skipped + page.skipped,
          failed: pull.failed + page.failed,
          deviceTrust: pull.deviceTrust ?? page.deviceTrust,
        };
      }
    } catch (err) {
      pullError = err instanceof Error ? err.message : "pull failed";
      logger.warn({ err }, "sync pull during sync/run failed");
    }

    // Best-effort: refill number blocks while online.
    let blocksError: string | null = null;
    if (ctx.syncDeviceId) {
      try {
        await numberBlocksUc.ensureDeviceNumberBlocks(
          container.documentNumberBlockRepo,
          container.fingerprintProvider,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: ctx.syncDeviceId,
            userId: ctx.userId,
            authHeader: req.headers.authorization,
          },
        );
      } catch (err) {
        blocksError = err instanceof Error ? err.message : "number-block ensure failed";
        logger.warn({ err }, "number-block ensure during sync/run failed");
      }
    }
    // 4B: one device-trust verdict per run, whichever side observed it. The
    // device must be able to say WHY it stopped (unknown / revoked / not bound)
    // and that its unsynced documents are still intact.
    const deviceTrust = push.deviceTrust ?? pull.deviceTrust ?? null;

    // Presence (another user logged in on another device), best-effort.
    let activity = 0;
    if (getCentralSyncUrl() && isHubReachableCached() !== false) {
      try {
        const events = await pullHubActivity(getHubSessionInfo()?.hubDeviceId ?? null);
        for (const e of events) {
          await container.notificationRepo.create(describeHubActivity(e), ctx);
          activity += 1;
        }
      } catch (err) {
        logger.debug({ err }, "hub activity pull failed");
      }
    }
    res.json({ ...push, deviceTrust, pull, pullError, blocksError, activity });
    } finally {
      let destroy = false;
      if (lockHeld) {
        try {
          await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
            `${ctx.tenantId}:sync-run`,
          ]);
        } catch {
          // A session-level advisory lock survives on a pooled connection;
          // destroy the client so the lock dies with it instead of blocking
          // every later sync run.
          destroy = true;
        }
      }
      lockClient.release(destroy);
    }
  });

  /**
   * Hub endpoint: FWW claims + use-case replay (PRE_ALLOCATED invoice create).
   *
   * Device gate: the asserted syncDeviceId must be REGISTERED to this tenant.
   * Device identity is self-asserted by header/body, so registration is what
   * makes a push attributable — an unknown id is rejected before any inbox,
   * claim, or materialization work happens. NULL ids stay allowed (local
   * unregistered flows) but push unattributed units.
   */
  router.post(
    "/sync/push",
    auth,
    guards.transportGuard,
    gate.attributed,
    validateBody(PushUnitSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof PushUnitSchema> })
        .validatedBody;
      const deviceId = body.syncDeviceId ?? ctx.syncDeviceId ?? null;
      if (!deviceId) {
        res.status(403).json({
          code: "SYNC_DEVICE_REQUIRED",
          message: "دفع المزامنة للمركز يتطلب جهاز مزامنة مسجّل",
        });
        return;
      }
      try {
        // Device attribution is enforced by `gate.attributed` above (registered,
        // not revoked, bound to the caller) — one enforcement point, shared with
        // pull and the number-block endpoints, instead of a per-route copy.
        const result = await syncUc.receiveSyncPush(
          container.syncInboxRepo,
          container.syncResourceClaimRepo,
          container.notificationRepo,
          {
            invoiceRepo: container.invoiceRepo,
            voucherRepo: container.voucherRepo,
            returnRepo: container.returnRepo,
            orderRepo: container.orderRepo,
            expenseRepo: container.expenseRepo,
            auditRepo: container.auditRepo,
            partyRepo: container.partyRepo,
            fabricRepo: container.fabricRepo,
            colorRepo: container.colorRepo,
            rollRepo: container.rollRepo,
            ledgerRepo: container.ledgerRepo,
            statementRepo: container.statementRepo,
            printJobRepo: container.printJobRepo,
            cashboxRepo: container.cashboxRepo,
            settingsRepo: container.settingsRepo,
            companyRepo: container.companyRepo,
          },
          container.db,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: deviceId,
            opId: body.opId,
            entityType: body.entityType,
            entityId: body.entityId,
            operation: body.operation,
            payload: body.payload as Record<string, unknown>,
            hubCtx: ctx,
          },
        );
        if (!result.accepted) {
          res.status(409).json({
            accepted: false,
            code: "SYNC_CONFLICT",
            message: result.message,
            conflictOpId: result.conflictOpId,
            conflicts: result.conflicts,
            inboxId: result.row.id,
            opId: result.row.opId,
            status: result.row.status,
          });
          return;
        }
        res.status(result.created ? 201 : 200).json({
          accepted: true,
          created: result.created,
          materialized: result.materialized,
          // P3a-completion: the device must know whether the hub is DONE
          // (applied/dead → stop retrying) or still working (received →
          // re-push later). hubStatus/hubReason name the terminal state.
          terminal: result.terminal,
          hubStatus: result.row.status,
          hubReason: result.row.rejectReason,
          inboxId: result.row.id,
          opId: result.row.opId,
          status: result.row.status,
        });
      } catch (err) {
        logger.error({ err }, "sync push receive failed");
        res.status(500).json({ code: "SYNC_PUSH_FAILED", message: "فشل استلام وحدة المزامنة" });
      }
    },
  );

  /** Hub → peer: list applied sync units after a monotonic cursor. */
  router.get("/sync/pull", auth, guards.readGuard, gate.pull, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    // Cursor is a sequence, not a timestamp: `received_at` is transaction-start
    // time, so a strict `>` against it permanently skips rows that tie with it.
    const afterSeqRaw = typeof req.query.afterSeq === "string" ? req.query.afterSeq : null;
    let afterSeq: number | null = null;
    if (afterSeqRaw !== null && afterSeqRaw !== "") {
      const parsed = Number(afterSeqRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res.status(400).json({ code: "BAD_REQUEST", message: "afterSeq يجب أن يكون رقماً" });
        return;
      }
      afterSeq = parsed;
    }
    // P1-4 / SYNC-07: exclusion is derived exclusively from the authenticated
    // device binding. Never trust a client-supplied query parameter here: a
    // caller could otherwise hide another device's units or influence cursor
    // progress by naming an arbitrary tenant device. The query parameter is
    // intentionally ignored (legacy clients remain safe; idempotent replay
    // handles any duplicate delivery).
    const exclude = ctx.syncDeviceId ?? null;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    const rows = await container.syncInboxRepo.listAppliedSince(ctx.tenantId, afterSeq, {
      excludeSyncDeviceId: exclude && /^[0-9a-f-]{36}$/i.test(exclude) ? exclude : null,
      limit,
    });
    res.json({
      items: rows.map((r) => ({
        opId: r.opId,
        syncDeviceId: r.syncDeviceId,
        entityType: r.entityType,
        entityId: r.entityId,
        operation: r.operation,
        payload: r.payload,
        // Devices store this field as their pull cursor. It carries the
        // APPLICATION order (applied_seq) — see the 20261016 migration. Rows
        // applied before that migration have applied_seq = received_seq, so
        // cursors already stored on devices stay valid.
        receivedSeq: r.appliedSeq ?? r.receivedSeq,
        appliedSeq: r.appliedSeq,
        receivedAt: r.receivedAt.toISOString(),
        appliedAt: r.appliedAt?.toISOString() ?? null,
      })),
    });
  });

  /** Claim a reserved number block for a sync device (hub or local authority). */
  router.post(
    "/sync/number-blocks/claim",
    auth,
    guards.numberingGuard,
    gate.attributed,
    validateBody(ClaimBlockSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof ClaimBlockSchema> })
        .validatedBody;
      try {
        const block = await numberBlocksUc.claimNumberBlock({
          tenantId: ctx.tenantId,
          syncDeviceId: body.syncDeviceId,
          entityType: body.entityType,
          size: body.size,
          knownUsed: body.knownUsed ?? null,
        });
        res.status(201).json({
          ...block,
          preAllocated: true,
        });
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block claim failed");
        res
          .status(500)
          .json({ code: "NUMBER_BLOCK_CLAIM_FAILED", message: "فشل حجز كتلة الترقيم" });
      }
    },
  );

  /** Ensure active blocks exist (local claim or hub proxy). */
  router.post(
    "/sync/number-blocks/ensure",
    auth,
    guards.numberingGuard,
    gate.attributed,
    validateBody(EnsureBlocksSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof EnsureBlocksSchema> })
        .validatedBody;
      try {
        const result = await numberBlocksUc.ensureDeviceNumberBlocks(
          container.documentNumberBlockRepo,
          container.fingerprintProvider,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: body.syncDeviceId,
            userId: ctx.userId,
            authHeader: req.headers.authorization,
            entityTypes: body.entityTypes,
          },
        );
        res.json(result);
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block ensure failed");
        res.status(500).json({
          code: "NUMBER_BLOCK_ENSURE_FAILED",
          message: "فشل تجهيز كتل الترقيم",
        });
      }
    },
  );

  router.get("/sync/number-blocks", auth, guards.readGuard, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const deviceId =
      (typeof req.query.syncDeviceId === "string" && req.query.syncDeviceId) ||
      ctx.syncDeviceId ||
      null;
    if (!deviceId) {
      res.status(400).json({ code: "SYNC_DEVICE_REQUIRED", message: "معرّف جهاز المزامنة مطلوب" });
      return;
    }
    const rows = await container.documentNumberBlockRepo.listForDevice(ctx.tenantId, deviceId);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        year: r.year,
        prefix: r.prefix,
        startNumber: r.startNumber,
        endNumber: r.endNumber,
        nextNumber: r.nextNumber,
        remaining: Math.max(0, r.endNumber - r.nextNumber + 1),
        status: r.status,
        claimedAt: r.claimedAt,
      })),
    });
  });

  router.post(
    "/sync/number-blocks/reclaim",
    auth,
    guards.operatorGuard,
    gate.attributed,
    validateBody(ReclaimBlockSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof ReclaimBlockSchema> })
        .validatedBody;
      try {
        const result = await numberBlocksUc.reclaimNumberBlock({
          tenantId: ctx.tenantId,
          blockId: body.blockId,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block reclaim failed");
        res.status(500).json({
          code: "NUMBER_BLOCK_RECLAIM_FAILED",
          message: "فشل استرداد ذيل الكتلة",
        });
      }
    },
  );

  /* ------------------------------------------------------------------ */
  /* Device lifecycle (Batch 4 / 4B)                                     */
  /*                                                                     */
  /* Revocation is the operator's answer to a lost, stolen, replaced or  */
  /* compromised device. It is non-destructive: no unit, number block or */
  /* claim is deleted, and nothing already attributed to the device is   */
  /* rewritten — the device simply loses its authority to register, push */
  /* and pull. Units it already pushed stay in the hub inbox and remain  */
  /* resolvable, so revoking never destroys bookkeeping.                 */
  /* ------------------------------------------------------------------ */

  /** Operator view of the tenant's devices, revoked ones included. */
  router.get(
    "/sync/devices",
    auth,
    guards.operatorGuard,
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const rows = await container.syncDeviceRepo.listForTenant(ctx.tenantId);
      res.json({
        items: rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          hostname: r.hostname,
          label: r.label,
          fingerprintVersion: r.deviceFingerprintVersion,
          authorizedUserIds: r.authorizedUserIds,
          lastSeenByUserId: r.lastSeenByUserId,
          lastSeenAt: r.lastSeenAt,
          createdAt: r.createdAt,
          revokedAt: r.revokedAt,
          revokeReason: r.revokeReason,
        })),
      });
    },
  );

  /** Revoke a device: all subsequent register/push/pull attempts are refused. */
  router.post(
    "/sync/devices/:deviceId/revoke",
    auth,
    guards.operatorGuard,
    validateBody(RevokeDeviceSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const deviceId = String(req.params.deviceId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
        res.status(400).json({ code: "BAD_REQUEST", message: "معرّف الجهاز غير صالح" });
        return;
      }
      const reason = (req.body as { reason?: string } | undefined)?.reason ?? "operator_action";
      const row = await container.syncDeviceRepo.setRevoked(ctx.tenantId, deviceId, true, reason);
      if (!row) {
        res.status(404).json({ code: "NOT_FOUND", message: "الجهاز غير موجود لدى هذه الشركة" });
        return;
      }
      logger.warn(
        { tenantId: ctx.tenantId, byUserId: ctx.userId, deviceId, reason },
        "operator revoked sync device",
      );
      for (const uid of row.authorizedUserIds ?? []) {
        await revokeSubjectSessions(uid, ctx.tenantId);
      }
      res.json({ ok: true, id: row.id, revokedAt: row.revokedAt, revokeReason: row.revokeReason });
    },
  );

  /**
   * Reinstate a revoked device. Explicit and separate from revoke so an
   * accidental revocation is recoverable without SQL — the row and its
   * bindings are untouched by revocation, so reinstating restores exactly the
   * previous authority (users must still be bound, which revocation preserved).
   */
  router.post(
    "/sync/devices/:deviceId/reinstate",
    auth,
    guards.operatorGuard,
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const deviceId = String(req.params.deviceId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
        res.status(400).json({ code: "BAD_REQUEST", message: "معرّف الجهاز غير صالح" });
        return;
      }
      const row = await container.syncDeviceRepo.setRevoked(ctx.tenantId, deviceId, false, null);
      if (!row) {
        res.status(404).json({ code: "NOT_FOUND", message: "الجهاز غير موجود لدى هذه الشركة" });
        return;
      }
      logger.warn(
        { tenantId: ctx.tenantId, byUserId: ctx.userId, deviceId },
        "operator reinstated sync device",
      );
      res.json({ ok: true, id: row.id, revokedAt: row.revokedAt });
    },
  );
}
