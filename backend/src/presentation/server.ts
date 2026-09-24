import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";
import { config, corsOrigins } from "../infrastructure/config/env.js";
import { logger } from "../infrastructure/config/logger.js";
import { buildContainer } from "../infrastructure/di/container.js";
import { createAuthMiddleware } from "../infrastructure/http/middleware/auth.middleware.js";
import { requestIdMiddleware } from "../infrastructure/http/middleware/request-id.middleware.js";
import { createErrorHandler } from "../infrastructure/http/middleware/error-handler.middleware.js";
import { registerAuthRoutes } from "./routes/auth.route.js";
import { registerUserRoutes } from "./routes/user.route.js";
import { registerHealthRoutes } from "./routes/health.route.js";
import { checkDatabase } from "../infrastructure/orm/drizzle.js";
import { checkRedis } from "../infrastructure/auth/TokenDenylist.js";
import { registerPartyRoutes } from "./routes/party.route.js";
import { rbac } from "../infrastructure/http/middleware/rbac.middleware.js";
import { createSyncDeviceGate } from "../infrastructure/http/middleware/sync-device-gate.middleware.js";
import { registerFabricRoutes } from "./routes/fabric.route.js";
import { registerColorRoutes } from "./routes/color.route.js";
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
import { renameSync, writeFileSync } from "node:fs";
import { registerSetupRoutes } from "./routes/setup.route.js";
import { registerProfitRoutes } from "./routes/profit.route.js";
import { registerCompanyRoutes } from "./routes/company.route.js";
import {
  registerInvitationAdminRoutes,
  registerInvitationPublicRoutes,
} from "./routes/invitation.route.js";
import { registerAuditRoutes } from "./routes/audit.route.js";
import { createBackupRouter } from "./routes/backup.route.js";
import { registerDocumentTrackRoutes } from "./routes/documentTrack.route.js";
import { PostgresDocumentTrackRepository } from "../infrastructure/repositories/PostgresDocumentTrackRepository.js";
import { createIntegrityRouter } from "./routes/integrity.route.js";
import { dataSafeModeGuard } from "../infrastructure/http/middleware/dataSafeMode.middleware.js";
import { registerFxRoutes } from "./routes/fx.route.js";
import { registerSyncRoutes } from "./routes/sync.route.js";
import { registerSearchRoutes } from "./routes/search.route.js";
import { registerReportRoutes } from "./routes/reports.route.js";
import { registerSyncBootstrapRoutes } from "./routes/syncBootstrap.route.js";
import { getCentralSyncUrl, probeHubReachable } from "../application/use-cases/sync/hubConfig.js";
import { FxRateService } from "../infrastructure/fx/FxRateService.js";
import { offlineWriteGuard } from "../infrastructure/http/middleware/offline-write.middleware.js";
import { createLicenseHeartbeatMiddleware } from "../infrastructure/http/middleware/license.heartbeat.middleware.js";
import { createInstallGateMiddleware } from "../infrastructure/http/middleware/install.gate.middleware.js";
import { createLicenseGuard } from "../infrastructure/http/middleware/license.guard.middleware.js";
import { requireFeature } from "../infrastructure/http/middleware/license.enforcement.middleware.js";
import { FEATURES } from "../domain/licensing/features.js";
import { setLicenseIdentityDegraded } from "../infrastructure/license/licenseIdentityHealth.js";

// Crash reporting & APM — guarded so it never blocks startup
if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV ?? "development",
    tracesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,
    profilesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,
  });
  logger.info({ dsn: config.SENTRY_DSN.slice(0, 30) + "…" }, "Sentry initialized");
} else {
  logger.warn("SENTRY_DSN not set — crash reporting is disabled");
}

const app = express();
app.set("trust proxy", 1);
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
app.use(express.json({ limit: "10mb" }));

// Request logging
app.use((req, _res, next) => {
  logger.info({ requestId: req.id, method: req.method, path: req.path }, "Request started");
  next();
});

// Install gate — blocks business traffic with 503 SETUP_REQUIRED until the
// setup wizard is completed. Health/setup/invitation-entry paths stay open so
// a fresh install can always be provisioned (see ALLOW_LIST in the gate).
app.use(createInstallGateMiddleware(container.installationStateRepo, container.tenantRepo));
app.use(dataSafeModeGuard());

// ── Route registration ──────────────────────────────────────────────
// health + auth already hard-code the `/api` prefix internally → mount at root.
const router = express.Router();
registerHealthRoutes(router, checkDatabase, checkRedis, rbac, authMiddleware);
registerAuthRoutes(router, container);
// Phase-0 platform routes (license / setup / company / invitations) also
// hard-code the `/api` prefix → mount at root like auth & health.
registerLicenseRoutes(router, container, authMiddleware);
registerSetupRoutes(router, container);
registerCompanyRoutes(router, container, authMiddleware);
registerInvitationAdminRoutes(router, container, authMiddleware, rbac(["admin"]));
registerInvitationPublicRoutes(router, container);
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
  offlineWriteGuard,
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
);
registerPartyRoutes(
  apiRouter,
  container.partyRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.syncOutboxRepo,
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
  new PostgresDocumentTrackRepository(container.db),
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerReportRoutes(
  apiRouter,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
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
registerSyncRoutes(
  apiRouter,
  container,
  authMiddleware,
  {
    readGuard: rbac(["admin", "accountant", "warehouse", "viewer"]),
    transportGuard: rbac(["admin", "accountant"]),
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
apiRouter.use(createIntegrityRouter(authMiddleware));

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

// Start server. Desktop boot has one schema authority: the Drizzle migration
// runner. Do not patch the live database with bespoke CREATE/ALTER statements.
async function prepareDesktopDatabase(): Promise<void> {
  if (!config.DESKTOP_DEPLOY) return;
  const { runDesktopMigrations } = await import("../infrastructure/orm/runDesktopMigrations.js");
  await runDesktopMigrations();
  // REPAIR-023 / REPAIR-026: integrity + tenant visibility after migrations.
  try {
    const { pool } = await import("../infrastructure/orm/drizzle.js");
    const { verifyDataAgainstManifest } =
      await import("../infrastructure/integrity/dataIntegrityManifest.js");
    const tenantRes = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    const tenantId = tenantRes.rows[0]?.id;
    if (tenantId) {
      await verifyDataAgainstManifest(pool, tenantId);
      // Tenant visibility check (REPAIR-026)
      const byTenant = await pool.query<{ tenant_id: string; n: number }>(
        `SELECT tenant_id, count(*)::int AS n FROM invoices GROUP BY tenant_id`,
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
    const { enterSafeMode } =
      await import("../infrastructure/integrity/dataIntegrityManifest.js");
    enterSafeMode("INTEGRITY_CHECK_FAILED");
    logger.fatal({ err, bootId: process.env.MOTARD_BOOT_ID }, "DATA_INTEGRITY_CHECK_FAILED");
  }
}

/** Detach stale baked Desktop licenses that are not the tenant entitlement. */
async function prepareLicenseIdentity(): Promise<void> {
  try {
    const { db } = await import("../infrastructure/orm/drizzle.js");
    const { detachOrphanBakedLicenses } =
      await import("../infrastructure/license/detachOrphanBakedLicenses.js");
    await detachOrphanBakedLicenses(db);
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
void prepareDesktopDatabase()
  .then(() => prepareLicenseIdentity())
  .then(() => {
    const server = app.listen(config.PORT, config.HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.PORT;
      logger.info(`ERP API server listening on ${config.HOST}:${port} in ${config.NODE_ENV} mode`);
      // The desktop shell learns the (dynamic) port from this file. It is written LAST, after the server is
      // really accepting connections, so "port file exists" == "ready to serve". Write + rename = atomic.
      if (config.DESKTOP_PORT_FILE) {
        const tmp = `${config.DESKTOP_PORT_FILE}.tmp`;
        writeFileSync(tmp, JSON.stringify({ port, pid: process.pid }));
        renameSync(tmp, config.DESKTOP_PORT_FILE);
      }
      if (getCentralSyncUrl()) {
        void probeHubReachable(true);
        setInterval(() => {
          void probeHubReachable();
        }, 15_000).unref();
      }
      if (config.DESKTOP_DEPLOY) {
        void import("../infrastructure/backup/backupScheduler.js").then((m) =>
          m.startBackupScheduler(),
        );
        void import("../infrastructure/orm/drizzle.js").then(({ pool }) =>
          import("../infrastructure/integrity/retentionJobs.js").then((m) =>
            m.startRetentionJobs(pool),
          ),
        );
      }
    });
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

export default app;
