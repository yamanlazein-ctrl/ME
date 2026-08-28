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
import { registerHealthRoutes } from "./routes/health.route.js";
import { checkDatabase } from "../infrastructure/orm/drizzle.js";
import { checkRedis } from "../infrastructure/auth/TokenDenylist.js";
import { registerPartyRoutes } from "./routes/party.route.js";
import { rbac } from "../infrastructure/http/middleware/rbac.middleware.js";
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
import { registerSetupRoutes } from "./routes/setup.route.js";
import { registerProfitRoutes } from "./routes/profit.route.js";
import { registerCompanyRoutes } from "./routes/company.route.js";
import {
  registerInvitationAdminRoutes,
  registerInvitationPublicRoutes,
} from "./routes/invitation.route.js";
import { registerAuditRoutes } from "./routes/audit.route.js";
import { backupRouter } from "./routes/backup.route.js";
import { registerFxRoutes } from "./routes/fx.route.js";
import { FxRateService } from "../infrastructure/fx/FxRateService.js";
import { createLicenseHeartbeatMiddleware } from "../infrastructure/http/middleware/license.heartbeat.middleware.js";
import { createInstallGateMiddleware } from "../infrastructure/http/middleware/install.gate.middleware.js";
import { createLicenseGuard } from "../infrastructure/http/middleware/license.guard.middleware.js";
import { requireFeature } from "../infrastructure/http/middleware/license.enforcement.middleware.js";
import { FEATURES } from "../domain/licensing/features.js";

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

// Security & compression middleware
// Pure JSON API — CSP governs only HTML documents. Allow same-origin
// connect (Chrome DevTools probes /.well-known/appspecific/... and would
// otherwise be blocked by helmet's default `default-src 'none'`).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'", "'self'"],
        connectSrc: ["'self'", "http://localhost:5173"],
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
    ],
    maxAge: 86400,
  }),
);

// Rate limiting
app.use(
  rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_RPS,
    standardHeaders: true,
    legacyHeaders: false,
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

// License heartbeat — sets req.license with status + grace info (never blocks)
app.use(
  createLicenseHeartbeatMiddleware(
    container.licenseRepo,
    container.secretsRepo,
    container.secretCipher,
    container.licenseTokenSigner,
  ),
);

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
// `req.tenantContext` exists (the guard no-ops without it), then the guard:
// revoked → 403, expired with grace exhausted → 403, expired within grace →
// allowed + `X-License-Grace` header. `active`/`trial`/`no_license` pass through.
apiRouter.use(
  authMiddleware,
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
apiRouter.use("/inventory", requireFeature(container.licenseRepo, FEATURES.INVENTORY));
apiRouter.use("/invoices", requireFeature(container.licenseRepo, FEATURES.SALES));
apiRouter.use("/orders", requireFeature(container.licenseRepo, FEATURES.SALES));
apiRouter.use("/returns", requireFeature(container.licenseRepo, FEATURES.SALES));
apiRouter.use("/profit", requireFeature(container.licenseRepo, FEATURES.REPORTS));
registerPartyRoutes(
  apiRouter,
  container.partyRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerFabricRoutes(
  apiRouter,
  container.fabricRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerColorRoutes(
  apiRouter,
  container.colorRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerRollRoutes(
  apiRouter,
  container.rollRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
  container.stockMovementRepo,
);
registerOrderRoutes(
  apiRouter,
  container.orderRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerInvoiceRoutes(
  apiRouter,
  container.invoiceRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerVoucherRoutes(
  apiRouter,
  container.voucherRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerLedgerRoutes(
  apiRouter,
  container.ledgerRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerStatementRoutes(
  apiRouter,
  container.statementRepo,
  container.partyRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerReturnRoutes(
  apiRouter,
  container.returnRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerCashboxRoutes(
  apiRouter,
  container.cashboxRepo,
  container.ledgerRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerExpenseRoutes(
  apiRouter,
  container.expenseRepo,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
registerPrintRoutes(
  apiRouter,
  container.printJobRepo,
  authMiddleware,
  rbac(["admin", "warehouse"]),
  rbac(["admin", "accountant", "warehouse", "viewer"]),
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
);
registerDashboardRoutes(
  apiRouter,
  container.dashboardRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
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
// Full backup endpoint — POST /api/backup/full (returns ZIP file) — admin-only, tenant-scoped
apiRouter.use(authMiddleware, rbac(["admin"]), backupRouter);

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

// Start server
// FX reference rate background refresh — non-blocking, never delays startup.
fxRateService.start();
app.listen(config.PORT, () => {
  logger.info(`ERP API server listening on port ${config.PORT} in ${config.NODE_ENV} mode`);
});

export default app;
