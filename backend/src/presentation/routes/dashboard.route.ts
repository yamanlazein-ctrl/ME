import type { Router, Request, Response, RequestHandler } from "express";
import type { IDashboardRepository } from "../../application/ports/IDashboardRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { getDashboardUseCase } from "../../application/use-cases/dashboard/dashboardUseCases.js";

export function registerDashboardRoutes(
  router: Router,
  dashboardRepo: IDashboardRepository,
  auth: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  router.get("/dashboard", auth, readGuard, async (req: Request, res: Response) => {
    const r = await getDashboardUseCase(dashboardRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });
}
