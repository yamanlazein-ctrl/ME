import { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../../infrastructure/config/env.js";
import type { Container } from "../../infrastructure/di/container.js";
import {
  startWizardUseCase,
  getStatusUseCase,
  activateAndPersistUseCase,
  saveCompanyStepUseCase,
  saveAdminStepUseCase,
  saveReviewStepUseCase,
  completeWizardUseCase,
} from "../../application/use-cases/setup/setupUseCases.js";

/**
 * Phase 0 sub-batch 0F — setup routes.
 *
 *   GET  /api/setup/status?tenantId=...
 *   POST /api/setup/init             (SETUP_TOKEN-gated; creates the tenant)
 *   POST /api/setup/wizard/activate  (consumes the activation key)
 *
 * The `SETUP_TOKEN` env guards the bootstrap path. In dev, the token is
 * optional; in production it is required and boot-time-enforced by
 * `env.ts` (fix for C-3, forensic audit 2026-08-15 — the app now refuses
 * to start with `NODE_ENV=production` and no `SETUP_TOKEN`).
 *
 * The token alone is NOT sufficient authorization for the wizard's
 * mutating steps (company/admin/review/complete): those additionally
 * require the target tenant's `isCompleted` flag to still be `false`
 * (enforced in setupUseCases.ts via `assertWizardMutable`). A shared or
 * leaked token must not be able to re-provision a tenant that has
 * already finished setup.
 */
function checkSetupToken(req: { headers: Record<string, unknown> }): boolean {
  // DESKTOP_DEPLOY: the customer runs the wizard locally on first launch with
  // no operator-provided SETUP_TOKEN. Access is instead gated by
  // requireLocalAccess (must come from loopback / private LAN, never the
  // internet) and by assertWizardMutable (re-locks once the install is
  // completed). See registerSetupRoutes.
  if (config.DESKTOP_DEPLOY) return true;
  if (!config.SETUP_TOKEN) {
    // In dev (or when no token is configured), allow without a token.
    // Fix C-3 (forensic audit 2026-08-15): read the validated, defaulted
    // `config.NODE_ENV` instead of the raw `process.env.NODE_ENV`. The raw
    // env var is `undefined` on any deployment that forgot to export it,
    // and `undefined !== "production"` is `true` — silently opening every
    // setup endpoint. `config.NODE_ENV` is Zod-validated with an explicit
    // default, and env.ts now refuses to boot in production without a
    // token at all, so this branch can only be reached in dev/test.
    return config.NODE_ENV !== "production";
  }
  const provided = (req.headers["x-setup-token"] as string | undefined) ?? "";
  return provided === config.SETUP_TOKEN;
}

/**
 * DESKTOP_DEPLOY guard for the setup wizard's mutating endpoints.
 *
 * The wizard runs locally on the customer's machine on first launch. It must
 * be reachable only from that machine (loopback) or the customer's own private
 * LAN — never from an arbitrary public address — so a device on the same
 * network as the host cannot drive the provisioning flow. The "first run only"
 * lock is enforced separately by assertWizardMutable inside each use case
 * (once isCompleted=true, every mutating step returns ALREADY_COMPLETED).
 */
function isLocalOrPrivateLan(ip: string | undefined): boolean {
  if (!ip) return false;
  const host = ip.replace(/^::ffff:/, "").split(":")[0];
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;

  // IPv4 private / link-local ranges.
  if (host.includes(".")) {
    if (host.startsWith("10.")) return true;
    if (host.startsWith("192.168.")) return true;
    if (host.startsWith("169.254.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }
  // IPv6 private (unique local) range.
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function requireLocalAccess(req: Request): boolean {
  if (!config.DESKTOP_DEPLOY) return checkSetupToken(req);
  return isLocalOrPrivateLan(req.ip ?? req.socket?.remoteAddress);
}

export function registerSetupRoutes(router: Router, container: Container): void {
  // Desktop SKU: wizard POSTs may carry a leftover tenantId from a failed first
  // Continue (the old /init minted a random tenant). Always pin mutating steps
  // to the seeded slug=`default` tenant that holds the baked license.
  async function resolveWizardTenantId(posted: string): Promise<string> {
    if (!config.DESKTOP_DEPLOY || !posted) return posted;
    const baked = await container.tenantRepo.findBySlug("default");
    return baked?.id ?? posted;
  }

  // GET /api/setup/status — read-only, no tenantId from query (was leaking other tenant's state)
  router.get("/api/setup/status", async (req, res, next) => {
    try {
      // Resolve the real install the same way the install gate does: the
      // operator-supplied bootstrap tenant, else the first tenant whose
      // wizard is already complete. The previous hardcoded "bootstrap" id
      // matched no row, so a fully provisioned install still reported
      // `isCompleted: false` and the activation gate would loop forever.
      let tenantId =
        process.env.BOOTSTRAP_TENANT_ID ??
        (await container.installationStateRepo.findAnyCompleted()) ??
        "bootstrap";
      if (config.DESKTOP_DEPLOY && !process.env.BOOTSTRAP_TENANT_ID) {
        const baked = await container.tenantRepo.findBySlug("default");
        if (baked) tenantId = baked.id;
      }
      const r = await getStatusUseCase(container.installationStateRepo, tenantId);
      if (!r.ok) {
        // Prefer any completed tenant over a hard false — a soft failure must
        // not re-open the wizard on a provisioned desktop install (P4).
        const done = await container.installationStateRepo.findAnyCompleted();
        if (done) {
          res.json({ isCompleted: true, currentStep: "done" });
          return;
        }
        res.status(503).json({
          code: "SETUP_STATUS_UNAVAILABLE",
          message: "تعذّر قراءة حالة الإعداد",
          statusCode: 503,
        });
        return;
      }
      res.json(r.data);
    } catch {
      try {
        const done = await container.installationStateRepo.findAnyCompleted();
        if (done) {
          res.json({ isCompleted: true, currentStep: "done" });
          return;
        }
      } catch {
        /* fall through */
      }
      // Fail the request so ActivationGate's catch can use local markers
      // instead of treating a transport/DB blip as "wizard required".
      res.status(503).json({
        code: "SETUP_STATUS_UNAVAILABLE",
        message: "تعذّر قراءة حالة الإعداد",
        statusCode: 503,
      });
    }
  });

  // POST /api/setup/init — SETUP_TOKEN gated
  router.post("/api/setup/init", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res.status(401).json({
          code: "UNAUTHORIZED",
          message: "رمز الإعداد غير صحيح",
          statusCode: 401,
        });
        return;
      }
      const r = await startWizardUseCase(
        container.tenantRepo,
        container.installationStateRepo,
        req.body,
      );
      if (!r.ok) {
        res.status(422).json({ code: "VALIDATION_ERROR", message: r.error, statusCode: 422 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/setup/wizard/activate — SETUP_TOKEN gated
  const activateBody = z.object({
    // Desktop pre-baked mode sends an empty key (no customer-entered license).
    key: config.DESKTOP_DEPLOY ? z.string().optional() : z.string().min(1),
    tenantId: z.string().uuid(),
  });
  router.post("/api/setup/wizard/activate", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "رمز الإعداد غير صحيح", statusCode: 401 });
        return;
      }
      const parsed = activateBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "بيانات غير صالحة", statusCode: 422 });
        return;
      }
      const r = await activateAndPersistUseCase(
        {
          licenseProvider: container.licenseProvider,
          tenantRepo: container.tenantRepo,
          installationStateRepo: container.installationStateRepo,
          secretsRepo: container.secretsRepo,
          fingerprintProvider: container.fingerprintProvider,
          installationIdStorage: container.installationIdStorage,
          tokenSigner: container.licenseTokenSigner,
          licenseRepo: container.licenseRepo,
        },
        await resolveWizardTenantId(parsed.data.tenantId),
        { key: parsed.data.key ?? "" },
      );
      if (!r.ok) {
        res.status(400).json({ code: "ACTIVATION_FAILED", message: r.error, statusCode: 400 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/setup/wizard/company
  router.post("/api/setup/wizard/company", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "رمز الإعداد غير صحيح", statusCode: 401 });
        return;
      }
      const tenantId = await resolveWizardTenantId((req.body?.tenantId as string) ?? "");
      if (!tenantId) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "tenantId مطلوب", statusCode: 422 });
        return;
      }
      const r = await saveCompanyStepUseCase(
        container.companyRepo,
        container.installationStateRepo,
        tenantId,
        req.body,
      );
      if (!r.ok) {
        if (r.code === "ALREADY_COMPLETED") {
          res.status(409).json({ code: r.code, message: r.error, statusCode: 409 });
          return;
        }
        res.status(422).json({ code: "VALIDATION_ERROR", message: r.error, statusCode: 422 });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/setup/wizard/admin
  router.post("/api/setup/wizard/admin", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "رمز الإعداد غير صحيح", statusCode: 401 });
        return;
      }
      const tenantId = await resolveWizardTenantId((req.body?.tenantId as string) ?? "");
      const r = await saveAdminStepUseCase(
        {
          installationStateRepo: container.installationStateRepo,
          passwordHasher: container.passwordHasher,
        },
        tenantId,
        req.body,
      );
      if (!r.ok) {
        if (r.code === "ALREADY_COMPLETED") {
          res.status(409).json({ code: r.code, message: r.error, statusCode: 409 });
          return;
        }
        res.status(422).json({ code: "VALIDATION_ERROR", message: r.error, statusCode: 422 });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/setup/wizard/review
  router.post("/api/setup/wizard/review", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "رمز الإعداد غير صحيح", statusCode: 401 });
        return;
      }
      const tenantId = await resolveWizardTenantId((req.body?.tenantId as string) ?? "");
      const r = await saveReviewStepUseCase(container.installationStateRepo, tenantId, req.body);
      if (!r.ok) {
        if (r.code === "ALREADY_COMPLETED") {
          res.status(409).json({ code: r.code, message: r.error, statusCode: 409 });
          return;
        }
        res.status(422).json({ code: "VALIDATION_ERROR", message: r.error, statusCode: 422 });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/setup/wizard/complete
  router.post("/api/setup/wizard/complete", async (req, res, next) => {
    try {
      if (!requireLocalAccess(req)) {
        res
          .status(401)
          .json({ code: "UNAUTHORIZED", message: "رمز الإعداد غير صحيح", statusCode: 401 });
        return;
      }
      const tenantId = await resolveWizardTenantId((req.body?.tenantId as string) ?? "");
      if (!tenantId) {
        res.status(422).json({ code: "VALIDATION_ERROR", message: "tenantId مطلوب", statusCode: 422 });
        return;
      }
      const r = await completeWizardUseCase(
        {
          installationStateRepo: container.installationStateRepo,
          authRepo: container.authRepo,
        },
        tenantId,
      );
      if (!r.ok) {
        res.status(500).json({ code: "INTERNAL", message: r.error, statusCode: 500 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });
}
