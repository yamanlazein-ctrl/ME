import express from "express";
import { logFailedResponses } from "../infrastructure/http/middleware/failed-response-log.middleware.js";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "../infrastructure/config/sentryScrub.js";
import { installProcessGuards, markServing } from "../infrastructure/config/processGuard.js";
import { config, corsOrigins } from "../infrastructure/config/env.js";
import { logger } from "../infrastructure/config/logger.js";
import { buildContainer } from "../infrastructure/di/container.js";
import { createAuthMiddleware } from "../infrastructure/http/middleware/auth.middleware.js";
import { requestIdMiddleware } from "../infrastructure/http/middleware/request-id.middleware.js";
import { createErrorHandler } from "../infrastructure/http/middleware/error-handler.middleware.js";
import { registerAuthRoutes } from "./routes/auth.route.js";
import { registerUserRoutes } from "./routes/user.route.js";
import { registerHealthRoutes } from "./routes/health.route.js";
import { registerMobileVersionRoute } from "./routes/mobileVersion.route.js";
import { registerDesktopRuntimeRoutes } from "./routes/desktopRuntime.route.js";
import { checkDatabase, getEngine } from "../infrastructure/orm/engine.js";
import { checkRedis } from "../infrastructure/auth/TokenDenylist.js";
import { registerPartyRoutes } from "./routes/party.route.js";
import { rbac } from "../infrastructure/http/middleware/rbac.middleware.js";
import { createSyncDeviceGate } from "../infrastructure/http/middleware/sync-device-gate.middleware.js";
import { registerFabricRoutes } from "./routes/fabric.route.js";
import { registerColorRoutes } from "./routes/color.route.js";
import { registerDyeRoutes } from "./routes/dye.route.js";
import { registerYearClosingRoutes } from "./routes/year-closing.route.js";
import { registerRollRoutes } from "./routes/roll.route.js";
import { registerOrderRoutes } from "./routes/order.route.js";
import { registerInvoiceRoutes } from "./routes/invoice.route.js";
import { registerVoucherRoutes } from "./routes/voucher.route.js";
import { registerLedgerRoutes } from "./routes/ledger.route.js";
import { registerStatementRoutes } from "./routes/statement.route.js";
import { registerReturnRoutes } from "./routes/return.route.js";
import { registerCashboxRoutes } from "./routes/cashbox.route.js";
import { registerExpenseRoutes } from "./routes/expense.route.js";
import { registerPrintRoutes } from "./routes/print.route.js";
import { registerNotificationRoutes } from "./routes/notification.route.js";
import { registerSettingsRoutes } from "./routes/settings.route.js";
import { registerDashboardRoutes } from "./routes/dashboard.route.js";
import { registerLicenseRoutes } from "./routes/license.route.js";
import { mountStaticApp } from "./staticApp.js";
import { startupFailureReason } from "../infrastructure/config/startupFailure.js";
import { registerSetupRoutes } from "./routes/setup.route.js";
import { registerProfitRoutes } from "./routes/profit.route.js";
import { registerCompanyRoutes } from "./routes/company.route.js";
import {
  registerInvitationAdminRoutes,
  registerInvitationPublicRoutes,
} from "./routes/invitation.route.js";
import { registerAuditRoutes } from "./routes/audit.route.js";
import { appVersion, createBackupRouter } from "./routes/backup.route.js";
import { registerDocumentTrackRoutes } from "./routes/documentTrack.route.js";
import { createIntegrityRouter } from "./routes/integrity.route.js";
import { dataSafeModeGuard } from "../infrastructure/http/middleware/dataSafeMode.middleware.js";
import { hubWriteFreezeGuard } from "../infrastructure/http/middleware/hubWriteFreeze.middleware.js";
import { syncVersionGuard } from "../infrastructure/http/middleware/syncVersionGuard.middleware.js";
import { registerFxRoutes } from "./routes/fx.route.js";
import { registerSyncRoutes } from "./routes/sync.route.js";
import { registerSearchRoutes } from "./routes/search.route.js";
import { registerReportRoutes } from "./routes/reports.route.js";
import { registerSyncBootstrapRoutes } from "./routes/syncBootstrap.route.js";
import { registerSyncEnrollmentPublicRoutes } from "./routes/syncEnrollment.route.js";
import { userFacingErrors } from "../infrastructure/http/middleware/userFacingErrors.middleware.js";
import { getCentralSyncUrl, probeHubReachable } from "../application/use-cases/sync/hubConfig.js";
import { FxRateService } from "../infrastructure/fx/FxRateService.js";
import { createLicenseHeartbeatMiddleware } from "../infrastructure/http/middleware/license.heartbeat.middleware.js";
import { createInstallGateMiddleware } from "../infrastructure/http/middleware/install.gate.middleware.js";
import { createLicenseGuard } from "../infrastructure/http/middleware/license.guard.middleware.js";
import { requireFeature } from "../infrastructure/http/middleware/license.enforcement.middleware.js";
import { FEATURES } from "../domain/licensing/features.js";
import { setLicenseIdentityDegraded } from "../infrastructure/license/licenseIdentityHealth.js";

// MUST run before anything that can fault: an uncaught 'error' event on a
// stream/timer is what used to take the whole desktop app down and leave the
// WebView2 window on its built-in "can't reach this page" screen. Start-up
// refusals stay fatal — they call process.exit(1) explicitly, which this
// guard never intercepts — and so does any uncaught fault before the server is
// listening (a throw while building the container used to leave a live process
// with no port, which a cloud host only reports as "no open ports").
installProcessGuards({ fatalUntilServing: true });

// Crash reporting & APM — guarded so it never blocks startup
if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV ?? "development",
    tracesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,
    profilesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,
    // Privacy: no PII, and tokens/cookies/bodies are stripped from every event (sentryScrub.ts).
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
  });
  logger.info({ dsn: config.SENTRY_DSN.slice(0, 30) + "…" }, "Sentry initialized");
} else {
  logger.warn("SENTRY_DSN not set — crash reporting is disabled");
}

const app = express();
// The hub sits behind one reverse proxy; the desktop sidecar has none, so trusting X-Forwarded-For
// there would let any caller claim `127.0.0.1` and pass the loopback checks (SEC-01 / SEC-04).
app.set("trust proxy", config.DESKTOP_DEPLOY ? false : 1);
const container = buildContainer();
const authMiddleware = createAuthMiddleware(container.jwtSigner, container.tokenDenylist);

// FX reference rate — display-only header widget (⛔ never billing logic).
// The backend fetches the provider on a timer into an in-memory cache; the
// browser only ever calls GET /api/fx/reference-rate (see registerFxRoutes).
const fxRateService = new FxRateService({
  upstreamUrl: config.FX_UPSTREAM_URL,
  refreshIntervalMs: config.FX_REFRESH_INTERVAL_MS,
  fetchTimeoutMs: config.FX_FETCH_TIMEOUT_MS,
});

// Desktop: the built frontend is served from this same process/origin (before helmet, which would apply the
// API's `default-src 'none'` CSP to the HTML documents).
if (config.SERVE_STATIC_DIR) {
  mountStaticApp(app, config.SERVE_STATIC_DIR);
}

// Security & compression middleware
// Pure JSON API — CSP governs only HTML documents. Allow same-origin
// connect (Chrome DevTools probes /.well-known/appspecific/... and would
// otherwise be blocked by helmet's default `default-src 'none'`).
app.use(
  helmet({
    // JSON API is called cross-origin from Vite (:5173) and SSR (:4173).
    // Helmet's default CORP `same-origin` blocks browsers from reading those
    // responses even when CORS allowlists the Origin — Chrome then fails
    // `/api/setup/status` and ActivationGate falls through to the license wizard.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'", "'self'"],
        connectSrc: [
          "'self'",
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:4173",
          "http://127.0.0.1:4173",
        ],
      },
    },
  }),
);
app.use(compression());
app.use(
  cors({
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Tenant-Id",
      "X-Request-Id",
      "Idempotency-Key",
      // Device roster (PIN picker) and setup wizard pre-auth flows.
      "X-Device-Activation-Id",
      "X-Device-Fingerprint",
      "X-Setup-Token",
    ],
    maxAge: 86400,
  }),
);

// Rate limiting — remote clients only. This ERP is used from the same
// machine (Vite proxy + PIN picker + heartbeats all appear as 127.0.0.1 /
// ::1), so a global per-IP cap locks the operator out of their own login
// screen. Health stays unrestricted so probes cannot burn the budget.
function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const host = ip.replace(/^::ffff:/, "").split("%")[0];
  return (
    host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0:0:0:0:0:0:0:1"
  );
}
app.use(
  rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_RPS,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      config.NODE_ENV !== "production" ||
      Boolean(config.DESKTOP_PIPE) ||
      isLoopbackIp(req.ip) ||
      req.path.startsWith("/api/health") ||
      req.path.includes("device-roster"),
    handler: (_req, res) => {
      res.status(429).json({
        code: "RATE_LIMIT_EXCEEDED",
        message: "تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً",
        statusCode: 429,
      });
    },
  }),
);

// Request ID and body parsing
app.use(requestIdMiddleware);
app.use(userFacingErrors);
app.use(express.json({ limit: "10mb" }));

/** MIG-03 wiring for the hub (PostgreSQL): portable v2 archives, verified before they are kept. */
async function startHubBackups(): Promise<void> {
  const [{ startHubBackupScheduler }, v2, { pgPool }, tc] = await Promise.all([
    import("../infrastructure/backup/hubBackupScheduler.js"),
    import("../infrastructure/backup/portableBackup.js"),
    import("../infrastructure/orm/pgLazy.js"),
    import("../infrastructure/orm/tenant-context.js"),
  ]);
  const pool = await pgPool();
  startHubBackupScheduler({
    listTenants: () =>
      tc.runWithPlatformContext(async () => {
        const r = await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
        return r.rows.map((row) => row.id);
      }),
    createBackup: (tenantId, outFile) =>
      tc.runWithTenantContext({ tenantId }, async () => {
        await v2.createPortableBackup({
          connect: () => pool.connect(),
          tenantId,
          outFile,
          appVersion: appVersion(),
          logoDir: process.env.COMPANY_LOGO_DIR ?? null,
        });
      }),
    verifyBackup: async (file) => {
      await v2.openAndVerifyBackup(file);
    },
  });
}

// Request logging
app.use((req, res, next) => {
  logger.info({ requestId: req.id, method: req.method, path: req.path }, "Request started");
  next();
});
app.use(logFailedResponses);

// Install gate — blocks business traffic with 503 SETUP_REQUIRED until the
// setup wizard is completed. Health/setup/invitation-entry paths stay open so
// a fresh install can always be provisioned (see ALLOW_LIST in the gate).
app.use(createInstallGateMiddleware(container.installationStateRepo, container.tenantRepo));
app.use(dataSafeModeGuard());
// MIG-04/05: operator write freeze during a hub cutover / rollback (HUB_WRITE_FREEZE=1).
app.use(hubWriteFreezeGuard());

// ── Route registration ──────────────────────────────────────────────
// health + auth already hard-code the `/api` prefix internally → mount at root.
const router = express.Router();
registerHealthRoutes(router, checkDatabase, checkRedis, rbac, authMiddleware, container.healthRepo);
// BC-5: the mobile app's version manifest (public, next to the health routes).
registerMobileVersionRoute(router);
// Desktop runtime only (Rust shell over the named pipe; 404 for anyone else) — T083.
registerDesktopRuntimeRoutes(router);
registerAuthRoutes(router, container);
// Phase-0 platform routes (license / setup / company / invitations) also
// hard-code the `/api` prefix → mount at root like auth & health.
registerLicenseRoutes(router, container, authMiddleware);
registerSetupRoutes(router, container);
registerCompanyRoutes(router, container, authMiddleware);
registerInvitationAdminRoutes(router, container, authMiddleware, rbac(["admin"]));
registerInvitationPublicRoutes(router, container);
registerSyncEnrollmentPublicRoutes(router, container);
app.use(router);

// Business routes use bare paths (`/invoices`, `/customers`, ...) but the
// frontend API services call `/api/<resource>`. Mount them under `/api`
// so both sides agree.
const apiRouter = express.Router();
// License enforcement for business traffic. Runs authMiddleware first so
// `req.tenantContext` exists, then heartbeat (SoT suspend/revoke overrides
// cached token), then the guard: revoked/suspended → 403, expired with grace
// exhausted → 403, expired within grace → allowed + `X-License-Grace`.
apiRouter.use(
  authMiddleware,
  createLicenseHeartbeatMiddleware(
    container.licenseRepo,
    container.secretsRepo,
    container.secretCipher,
    container.licenseTokenSigner,
    container.tenantRepo,
  ),
  createLicenseGuard({
    licenseRepo: container.licenseRepo,
    secretsRepo: container.secretsRepo,
    signer: container.licenseTokenSigner,
    cipher: container.secretCipher,
    tokenDenylist: container.tokenDenylist,
  }),
);
// Feature gating per module (frozen spec §9 layer 2). Only features that are
// part of every issued plan are gated here, so an existing license can never
// lose access to a module it already uses.
// FINAL DECISION (owner, 2026-08-28): accounting is available in every plan
// (`feature.accounting` is in all PLANS entries) and its routes stay
// un-gated by design — this is a final decision, not an open item.
apiRouter.use(
  "/inventory",
  requireFeature(container.licenseRepo, container.tenantRepo, FEATURES.INVENTORY),
);
apiRouter.use(
  "/invoices",
  requireFeature(container.licenseRepo, container.tenantRepo, FEATURES.SALES),
);
apiRouter.use(
  "/orders",
  requireFeature(container.licenseRepo, container.tenantRepo, FEATURES.SALES),
);
apiRouter.use(
  "/returns",
  requireFeature(container.licenseRepo, container.tenantRepo, FEATURES.SALES),
);
apiRouter.use(
  "/profit",
  requireFeature(container.licenseRepo, container.tenantRepo, FEATURES.REPORTS),
);
// Typeahead/search routes must be registered BEFORE the entity routes:
// "/parties/search" would otherwise be captured by "/parties/:id" (400 UUID).
registerSearchRoutes(
  apiRouter,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.searchRepo,
);
registerPartyRoutes(
  apiRouter,
  container.partyRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  container.invoiceRepo,
  container.voucherRepo,
);
registerUserRoutes(
  apiRouter,
  container.userRepo,
  container.passwordHasher,
  authMiddleware,
  rbac(["admin"]),
  container.syncOutboxRepo,
);
registerFabricRoutes(
  apiRouter,
  container.fabricRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerColorRoutes(
  apiRouter,
  container.colorRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerDyeRoutes(
  apiRouter,
  authMiddleware,
  // A purge destroys financial documents, so it is admin/accountant only —
  // deliberately narrower than creating an inventory master.
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  // N-05: the purge is sync-exempt; refuse it while sync devices are enrolled.
  { devices: container.syncDeviceRepo },
);
registerYearClosingRoutes(
  apiRouter,
  authMiddleware,
  // Closing a year freezes the books and the inventory: accountant+admin, and
  // a warehouse counter may enter physical counts but not close the year.
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  // Reopen is the one operation that can unfreeze a closed year — admin only.
  rbac(["admin"]),
  container.syncOutboxRepo,
);
registerRollRoutes(
  apiRouter,
  container.rollRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.stockMovementRepo,
  container.syncOutboxRepo,
);
registerOrderRoutes(
  apiRouter,
  container.orderRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  container.partyRepo,
);
registerInvoiceRoutes(
  apiRouter,
  container.invoiceRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  {
    partyRepo: container.partyRepo,
    fabricRepo: container.fabricRepo,
    colorRepo: container.colorRepo,
    rollRepo: container.rollRepo,
  },
);
registerVoucherRoutes(
  apiRouter,
  container.voucherRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  container.partyRepo,
);
registerLedgerRoutes(
  apiRouter,
  container.ledgerRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerStatementRoutes(
  apiRouter,
  container.statementRepo,
  container.partyRepo,
  container.ledgerRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  container.voucherRepo,
  container.auditRepo,
);
registerReturnRoutes(
  apiRouter,
  container.returnRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
  {
    partyRepo: container.partyRepo,
    fabricRepo: container.fabricRepo,
    colorRepo: container.colorRepo,
    rollRepo: container.rollRepo,
  },
);
registerCashboxRoutes(
  apiRouter,
  container.cashboxRepo,
  container.ledgerRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerExpenseRoutes(
  apiRouter,
  container.expenseRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerPrintRoutes(
  apiRouter,
  container.printJobRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerNotificationRoutes(
  apiRouter,
  container.notificationRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  rbac(["admin", "accountant", "warehouse"]),
);
registerSettingsRoutes(
  apiRouter,
  container.settingsRepo,
  authMiddleware,
  rbac(["admin"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
);
registerDashboardRoutes(
  apiRouter,
  container.dashboardRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerDocumentTrackRoutes(
  apiRouter,
  container.documentTrackRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerReportRoutes(
  apiRouter,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.reportsRepo,
);
registerSyncBootstrapRoutes(apiRouter, authMiddleware);
// Profit endpoints were fully implemented but never mounted — the cashbox
// financial overview got 404s. Mounting the EXISTING route (no API changes).
registerProfitRoutes(
  apiRouter,
  container.profitRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerAuditRoutes(
  apiRouter,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
// FX reference rate — display-only header widget (⛔ never billing logic).
registerFxRoutes(apiRouter, fxRateService, authMiddleware);
// Sync surface (Batch 4): role guards + device-trust gates.
//   reads      → every authenticated role (same as dashboard/audit reads)
//   transport  → admin/accountant (writers). Pull stays on readGuard so warehouse
//                can still ingest peers. Device trust is additional, not instead.
//   numbering  → operational roles (viewer is read-only everywhere)
//   operator   → admin (claims repair, device revoke/reinstate)
const syncRuntime = registerSyncRoutes(
  apiRouter,
  container,
  authMiddleware,
  {
    readGuard: rbac(["admin", "accountant", "warehouse", "viewer"]),
    transportGuard: rbac(["admin", "accountant"]),
    syncVersionGuard,
    numberingGuard: rbac(["admin", "accountant", "warehouse"]),
    conflictGuard: rbac(["admin", "accountant", "warehouse"]),
    operatorGuard: rbac(["admin"]),
  },
  {
    attributed: createSyncDeviceGate(container.syncDeviceRepo, {
      unknownDevice: "reject",
      unboundUser: "reject",
    }),
    pull: createSyncDeviceGate(container.syncDeviceRepo, {
      unknownDevice: "reject",
      unboundUser: "reject",
      assertFromQuery: true,
    }),
    orchestration: createSyncDeviceGate(container.syncDeviceRepo, {
      unknownDevice: "allow",
      unboundUser: "allow",
    }),
  },
);
// Full backup endpoint — POST /api/backup/full (returns ZIP file) — admin-only, tenant-scoped
apiRouter.use(
  authMiddleware,
  rbac(["admin"]),
  createBackupRouter({
    invoiceRepo: container.invoiceRepo,
    voucherRepo: container.voucherRepo,
    partyRepo: container.partyRepo,
    statementRepo: container.statementRepo,
  }),
);
apiRouter.use(
  createIntegrityRouter(authMiddleware, {
    secretsRepo: container.secretsRepo,
    secretCipher: container.secretCipher,
    licenseRepo: container.licenseRepo,
  }),
);
// Google Drive archive — admin routes + fail-closed primary-device worker wiring.
// Desktop-SQLite only: the drive tables exist only in the desktop engine.
if (config.DESKTOP_DEPLOY && getEngine() === "sqlite") {
  void (async () => {
    try {
      const { wireDriveArchive } = await import("./driveArchiveWiring.js");
      const { sqliteDb } = await import("../infrastructure/orm/sqlite/transaction.js");
      const drive = await wireDriveArchive({
        db: sqliteDb(),
        // D-05: this installation's stable, device-bound id is the archive device identity.
        localDeviceId: config.MOTARD_INSTALLATION_ID || null,
        // Phase 2: the company name for the Drive root folder, read per pass. The desktop holds exactly
        // one completed tenant (findAnyCompleted fails loudly if there are more), so its profile name is
        // the company's name. No profile yet → null → the product-name fallback.
        companyName: async () => {
          const tenantId = await container.installationStateRepo.findAnyCompleted();
          if (!tenantId) return null;
          const profile = await container.companyRepo.findByTenant(tenantId);
          return profile?.name ?? null;
        },
      });
      apiRouter.use(drive.router);
      drive.start();
      logger.info("DRIVE_ARCHIVE_WORKER_STARTED");
    } catch (err) {
      logger.warn({ err }, "DRIVE_ARCHIVE_WORKER_START_FAILED (non-fatal)");
    }
  })();
}

app.use("/api", apiRouter);

// 404 catch-all — Express's default finalhandler hardcodes
// `Content-Security-Policy: default-src 'none'` on its HTML error page,
// which would override helmet's CSP and block Chrome DevTools' well-known
// probe (/.well-known/appspecific/com.chrome.devtools.json). Serve JSON
// instead so the header set by helmet above stays intact.
app.use((_req, res) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: "المسار غير موجود",
    statusCode: 404,
  });
});

// Sentry error handler — captures unhandled errors before our custom handler
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use(createErrorHandler(logger));

/**
 * Cloud hub only, opt-in (HUB_PREPARE_ON_BOOT=1): run the project's own
 * `scripts/migrate.mjs`, `apply-rls.mjs` and `verify-rls.mjs` before serving, then — once, while no
 * company exists —
 * `bootstrap-hub.mjs` with HUB_BOOTSTRAP_COMPANY / _EMAIL / _PASSWORD. A host
 * with no shell (e.g. Render's free plan) has no other place to run them. A
 * failure is fatal (the catch below): an unmigrated hub must never serve.
 */
async function prepareHubDatabase(): Promise<void> {
  if (config.DESKTOP_DEPLOY || process.env.HUB_PREPARE_ON_BOOT !== "1") return;
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
    if (r.status !== 0) throw new Error(`${args[0]} exited with ${r.status ?? r.signal}`);
  };
  run(["scripts/migrate.mjs"]);
  // M-06 (audit, checked live): the canonical RLS layer (enable-rls.sql) is not a drizzle migration,
  // so `migrate` never applied it and a hub served with an incomplete policy set (`tenants` and
  // `system_admins` without RLS, six sync tables on non-canonical policies). Apply it (idempotent),
  // then verify: a hub whose isolation contract fails must never serve, like an unmigrated one.
  run(["scripts/apply-rls.mjs"]);
  run(["scripts/verify-rls.mjs"]);
  const company = process.env.HUB_BOOTSTRAP_COMPANY;
  const email = process.env.HUB_BOOTSTRAP_EMAIL;
  const password = process.env.HUB_BOOTSTRAP_PASSWORD;
  if (company && email && password && !(await container.installationStateRepo.findAnyCompleted())) {
    run(["bootstrap-hub.mjs", company, email, password]);
  }
}

// Start server. Desktop boot has one schema authority: the Drizzle migration
// runner. Do not patch the live database with bespoke CREATE/ALTER statements.
async function prepareDesktopDatabase(): Promise<void> {
  if (!config.DESKTOP_DEPLOY) return;
  const { runDesktopMigrations } = await import("../infrastructure/orm/runDesktopMigrations.js");
  await runDesktopMigrations();
  // REPAIR-023 / REPAIR-026: integrity + tenant visibility after migrations.
  try {
    // Same checks on either engine; on SQLite they read through the reader connection
    // (drizzle.ts must never be imported there — it opens a PostgreSQL pool).
    const { getEngine } = await import("../infrastructure/orm/engine.js");
    const engine = getEngine();
    const pool: import("../infrastructure/orm/sqlite/queryable.js").RowsQueryable =
      engine === "sqlite"
        ? (await import("../infrastructure/orm/sqlite/queryable.js")).sqliteReaderQueryable()
        : (await import("../infrastructure/orm/drizzle.js")).pool;
    const { verifyDataAgainstManifest } =
      await import("../infrastructure/integrity/dataIntegrityManifest.js");
    const tenantRes = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    const tenantId = tenantRes.rows[0]?.id;
    if (tenantId) {
      await verifyDataAgainstManifest(pool, tenantId, engine);
      // Tenant visibility check (REPAIR-026)
      const byTenant = await pool.query<{ tenant_id: string; n: number }>(
        engine === "sqlite"
          ? `SELECT tenant_id, count(*) AS n FROM invoices GROUP BY tenant_id`
          : `SELECT tenant_id, count(*)::int AS n FROM invoices GROUP BY tenant_id`,
      );
      const effective = byTenant.rows.find((r) => r.tenant_id === tenantId);
      const other = byTenant.rows.find((r) => r.tenant_id !== tenantId && Number(r.n) > 0);
      logger.info(
        {
          bootId: process.env.MOTARD_BOOT_ID,
          tenantIdPrefix: tenantId.slice(0, 8),
          rows: Number(effective?.n ?? 0),
        },
        "TENANT_SELECTED",
      );
      if (other && Number(effective?.n ?? 0) === 0) {
        const { enterSafeMode } =
          await import("../infrastructure/integrity/dataIntegrityManifest.js");
        enterSafeMode("TENANT_MISMATCH");
        logger.fatal(
          { bootId: process.env.MOTARD_BOOT_ID, otherTenantPrefix: other.tenant_id.slice(0, 8) },
          "TENANT_MISMATCH",
        );
      }
    }
  } catch (err) {
    const { enterSafeMode } = await import("../infrastructure/integrity/dataIntegrityManifest.js");
    enterSafeMode("INTEGRITY_CHECK_FAILED");
    logger.fatal({ err, bootId: process.env.MOTARD_BOOT_ID }, "DATA_INTEGRITY_CHECK_FAILED");
  }
}

/**
 * DESK-005: after an explicit key reset the stored licence token cannot be decrypted any more and
 * the heartbeat would report the licence as expired. Re-promote the signed baked token (repair
 * only: a licence that was never activated is not promoted here).
 */
async function repairDesktopLicenseSecret(): Promise<void> {
  const tenant = await container.tenantRepo.findBySlug("default");
  if (!tenant) return;
  const { bootstrapDesktopLicenseUseCase } =
    await import("../application/use-cases/setup/setupUseCases.js");
  const r = await bootstrapDesktopLicenseUseCase(
    {
      licenseRepo: container.licenseRepo,
      secretsRepo: container.secretsRepo,
      tokenSigner: container.licenseTokenSigner,
      cipher: container.secretCipher,
    },
    tenant.id,
    { repairOnly: true },
  );
  if (r.ok && r.data?.migrated) logger.warn({ tenantId: tenant.id }, "LICENSE_SECRET_REPAIRED");
  if (!r.ok) logger.error({ code: r.code, error: r.error }, "licence secret repair failed");
}

/** Detach stale baked Desktop licenses that are not the tenant entitlement. */
async function prepareLicenseIdentity(): Promise<void> {
  try {
    const { engineDb } = await import("../infrastructure/orm/engineSchema.js");
    const { detachOrphanBakedLicenses } =
      await import("../infrastructure/license/detachOrphanBakedLicenses.js");
    await detachOrphanBakedLicenses(await engineDb());
    if (config.DESKTOP_DEPLOY) await repairDesktopLicenseSecret();
    setLicenseIdentityDegraded(null);
  } catch (err) {
    // FIN-18: a desktop app must still start if this maintenance step fails,
    // but a stale cross-tenant baked license must never be SILENTLY active.
    // Record the condition so /api/health/deep reports it instead of the
    // failure vanishing into a warn nobody reads.
    const reason = err instanceof Error ? err.message : "orphan baked license detach failed";
    setLicenseIdentityDegraded(reason);
    logger.error({ err }, "license identity preparation failed — state marked degraded");
  }
}

fxRateService.start();
void prepareHubDatabase()
  .then(() => prepareDesktopDatabase())
  .then(() => prepareLicenseIdentity())
  .then(() => {
    // Desktop listens on a WINDOWS NAMED PIPE, not a TCP port. The UI is
    // served by the Tauri shell over its own asset protocol and reaches this
    // process through Rust, so the API never needs an open port. `listen(path)`
    // speaks ordinary HTTP/1.1 over the pipe, which is why the whole app — every
    // middleware, route and test — is unchanged: only the bind target moved.
    const server = config.DESKTOP_PIPE
      ? app.listen(config.DESKTOP_PIPE, () => {
          markServing();
          logger.info(`ERP API server listening on pipe ${config.DESKTOP_PIPE}`);
          // Readiness is now "the pipe accepts a request", which the Rust shell
          // probes directly. No port file is written and none is needed.
          afterListen();
        })
      : app.listen(config.PORT, config.HOST, () => {
          markServing();
          const address = server?.address();
          const bound = typeof address === "object" && address ? address.port : config.PORT;
          logger.info(
            `ERP API server listening on ${config.HOST}:${bound} in ${config.NODE_ENV} mode`,
          );
          afterListen();
        });

    // A bind failure (EADDRINUSE on a port, or a pipe already owned by another
    // instance) arrives here as an asynchronous 'error' event, long after the
    // .then() above resolved — so its .catch() never sees it. A server that
    // cannot bind is genuinely unusable — write the real reason and exit.
    server.on("error", (err: NodeJS.ErrnoException) => {
      const reason = err.code ? `${err.code}: ${err.message}` : String(err);
      process.stderr.write(`[FATAL] Server startup failed: ${reason}\n`);
      logger.fatal({ err, code: err.code }, "HTTP listen failed — refusing to serve");
      process.exit(1);
    });

    function afterListen(): void {
      // Sync without a logged-in user (no-op until this device is paired).
      syncRuntime.startBackgroundSync();
      if (getCentralSyncUrl()) {
        void probeHubReachable(true);
        setInterval(() => {
          void probeHubReachable();
        }, 15_000).unref();
      }
      if (config.DESKTOP_DEPLOY && getEngine() === "sqlite") {
        void import("../infrastructure/backup/sqliteBackupScheduler.js").then((m) =>
          m.startSqliteBackupScheduler(),
        );
        void import("../infrastructure/integrity/retentionJobs.js").then((m) =>
          m.startSqliteRetentionJobs(),
        );
      } else if (config.DESKTOP_DEPLOY) {
        void import("../infrastructure/backup/backupScheduler.js").then((m) =>
          m.startBackupScheduler(),
        );
        void import("../infrastructure/orm/drizzle.js").then(({ pool }) =>
          import("../infrastructure/integrity/retentionJobs.js").then((m) =>
            m.startRetentionJobs(pool),
          ),
        );
      } else if (getEngine() !== "sqlite" && process.env.HUB_BACKUP_DIR?.trim()) {
        // MIG-03: the hub's own verified backups (opt-in; see hubBackupScheduler.ts).
        void startHubBackups();
      }
    }
  })
  .catch((err) => {
    // The structured log goes through pino's worker thread and can be lost when the process exits right after,
    // and the desktop shell only shows server.log. Write the REAL reason (the database's own message, which drizzle
    // keeps in `cause`) synchronously to stderr so the crash is never reported as an unrelated warning.
    process.stderr.write(`[FATAL] Server startup failed: ${startupFailureReason(err)}
`);
    logger.fatal(
      { err },
      "Desktop migrations / license identity prepare failed — refusing to listen",
    );
    process.exit(1);
  });

/**
 * Graceful stop (specs/001-desktop-sqlite-engine T041/T083): on SQLite, fold the WAL back into the
 * database file and close it before exiting. A kill without this is still safe (WAL + synchronous=FULL
 * recover every committed transaction on the next open); this only leaves a tidy single file.
 */
if (getEngine() === "sqlite") {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void import("../infrastructure/orm/sqlite/runtime.js")
      .then((m) => m.shutdownSqliteRuntime())
      .catch((err) => logger.error({ err }, "sqlite shutdown checkpoint failed"))
      .finally(() => {
        logger.info({ signal }, "backend stopped");
        process.exit(0);
      });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

export default app;
