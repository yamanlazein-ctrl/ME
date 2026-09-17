import type { Request, Response, NextFunction } from "express";
import type { IInstallationStateRepository } from "../../../application/ports/IInstallationStateRepository.js";
import type { ITenantRepository } from "../../../application/ports/ITenantRepository.js";
import { MultipleTenantsDetectedError } from "../../../domain/errors/index.js";

const ALLOW_LIST = [
  "/api/health",
  "/api/setup/status",
  "/api/setup/init",
  "/api/setup/wizard",
  "/api/invitations/validate",
  "/api/invitations/consume",
  "/api/auth/device-roster",
  "/api/auth/pin-login",
  "/api/auth/set-pin",
];

function isAllowed(path: string): boolean {
  return ALLOW_LIST.some((p) => path === p || path.startsWith(`${p}/`));
}

export function createInstallGateMiddleware(
  installationStateRepo: IInstallationStateRepository,
  tenantRepo: ITenantRepository,
) {
  return async function installGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (isAllowed(req.path)) {
      next();
      return;
    }
    // In production, BOOTSTRAP_TENANT_ID is set by the operator.
    // Otherwise (R13) resolve the sole tenant whose setup wizard has been
    // completed, so the gate does not depend on a hardcoded id that never
    // matches the tenant the wizard actually created. There must be no
    // further fallback to a hardcoded UUID here: doing so previously meant
    // a fresh install with no BOOTSTRAP_TENANT_ID and no completed wizard
    // silently probed a specific hardcoded tenant id left over from a dev
    // environment — harmless today only because that id matches nothing,
    // but a landmine if it ever did (see F01, Phase 1 foundation audit).
    let tenantId = process.env.BOOTSTRAP_TENANT_ID ?? null;
    try {
      if (!tenantId) {
        tenantId = await installationStateRepo.findAnyCompleted();
      }
      if (tenantId) {
        const state = await installationStateRepo.findByTenant(tenantId);
        if (state && state.isCompleted) {
          next();
          return;
        }
      }
    } catch (err) {
      if (err instanceof MultipleTenantsDetectedError) {
        res.status(500).json({ code: err.code, message: err.message, statusCode: 500 });
        return;
      }
      /* fall through to 503 */
    }
    res.status(503).json({
      code: "SETUP_REQUIRED",
      message: "يرجى إكمال معالج الإعداد",
      statusCode: 503,
    });
  };
}
