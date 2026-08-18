import type { Request, Response, NextFunction } from "express";
import type { IInstallationStateRepository } from "../../../application/ports/IInstallationStateRepository.js";
import type { ITenantRepository } from "../../../application/ports/ITenantRepository.js";

const ALLOW_LIST = [
  "/api/health",
  "/api/setup/status",
  "/api/setup/init",
  "/api/setup/wizard",
  "/api/invitations/validate",
  "/api/invitations/consume",
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
    // Otherwise (R13) resolve the first tenant whose setup wizard has
    // been completed, so the gate does not depend on a hardcoded id that
    // never matches the tenant the wizard actually created.
    let tenantId = process.env.BOOTSTRAP_TENANT_ID;
    if (!tenantId) {
      tenantId = (await installationStateRepo.findAnyCompleted()) ?? "d7b2a19f-d97c-46d0-9630-b9e457bd8e35";
    }
    try {
      const state = await installationStateRepo.findByTenant(tenantId);
      if (state && state.isCompleted) {
        next();
        return;
      }
    } catch {
      /* fall through to 503 */
    }
    res.status(503).json({
      code: "SETUP_REQUIRED",
      message: "يرجى إكمال معالج الإعداد",
      statusCode: 503,
    });
  };
}
