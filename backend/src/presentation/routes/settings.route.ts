import type { Router, Request, Response, RequestHandler } from "express";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import * as uc from "../../application/use-cases/settings/settingsUseCases.js";

export function registerSettingsRoutes(
  router: Router,
  settingsRepo: ISettingsRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  router.get("/settings", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.getSettingsUseCase(settingsRepo, ctx(req));
    if (r.ok) {
      res.json(r.data ?? {});
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.put("/settings/:section", auth, writeGuard, async (req: Request, res: Response) => {
    const section = req.params.section as string;
    if (
      ![
        "company",
        "currencies",
        "paymentMethods",
        "taxes",
        "units",
        "warehouses",
        "printing",
      ].includes(section)
    ) {
      return res.status(400).json({ code: "VALIDATION", message: "قسم غير صالح" });
    }
    const r = await uc.updateSettingsUseCase(settingsRepo, section, req.body, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
