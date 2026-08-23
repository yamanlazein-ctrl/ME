import type { Router, Request, Response, RequestHandler } from "express";
import { profitQuerySchema } from "@erp/shared";
import { validateQuery } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { IProfitRepository } from "../../application/ports/IProfitRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import * as uc from "../../application/use-cases/profit/profitUseCases.js";

export function registerProfitRoutes(
  router: Router,
  profitRepo: IProfitRepository,
  auth: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  // GET /api/profit/summary?fromDate=&toDate=&currency=
  router.get(
    "/profit/summary",
    auth,
    readGuard,
    validateQuery(profitQuerySchema),
    async (req: Request, res: Response) => {
      const query = req.validatedQuery as {
        fromDate?: string;
        toDate?: string;
        currency?: string;
      };
      const r = await uc.getProfitSummaryUseCase(profitRepo, query, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  // GET /api/profit/details?fromDate=&toDate=&currency=
  router.get(
    "/profit/details",
    auth,
    readGuard,
    validateQuery(profitQuerySchema),
    async (req: Request, res: Response) => {
      const query = req.validatedQuery as {
        fromDate?: string;
        toDate?: string;
        currency?: string;
      };
      const r = await uc.getProfitDetailsUseCase(profitRepo, query, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );
}
