import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";
import { config } from "../infrastructure/config/env.js";
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
import { registerCompanyRoutes } from "./routes/company.route.js";
import {
  registerInvitationAdminRoutes,
  registerInvitationPublicRoutes,
} from "./routes/invitation.route.js";
import { registerAuditRoutes } from "./routes/audit.route.js";
import { backupRouter } from "./routes/backup.route.js";
import { createLicenseHeartbeatMiddleware } from "../infrastructure/http/middleware/license.heartbeat.middleware.js";

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
    origin: config.CORS_ORIGIN,
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
registerHealthRoutes(router, checkDatabase, checkRedis, rbac);
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
registerAuditRoutes(
  apiRouter,
  container.auditRepo,
  authMiddleware,
  rbac(["admin", "accountant", "warehouse", "viewer"]),
);
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
app.listen(config.PORT, () => {
  logger.info(`ERP API server listening on port ${config.PORT} in ${config.NODE_ENV} mode`);
});

export default app;
