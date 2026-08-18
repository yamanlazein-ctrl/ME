import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createColorSchema, updateColorSchema, listColorsSchema } from "./color.schema.js";
import {
  createColorUseCase,
  updateColorUseCase,
  findColorUseCase,
  listColorsUseCase,
  deleteColorUseCase,
} from "../../application/use-cases/inventory/colorUseCases.js";

export function registerColorRoutes(
  router: Router,
  colorRepo: IColorRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/inventory/colors",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createColorSchema),
    async (req: Request, res: Response) => {
      const r = await createColorUseCase(colorRepo, body(req), ctx(req));
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.put(
    "/inventory/colors/:id",
    auth,
    writeGuard,
    validateBody(updateColorSchema),
    async (req: Request, res: Response) => {
      const r = await updateColorUseCase(
        colorRepo,
        pid(req),
        body<Record<string, unknown>>(req) as Record<string, unknown>,
        ctx(req),
      );
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/inventory/colors",
    auth,
    readGuard,
    validateQuery(listColorsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listColorsSchema>;
      const r = await listColorsUseCase(colorRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.delete("/inventory/colors/:id", auth, writeGuard, async (req: Request, res: Response) => {
    const r = await deleteColorUseCase(colorRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(422).json({ code: "VALIDATION", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "اللون غير موجود" });
    }
    res.status(204).send();
  });

  router.get("/inventory/colors/:id", auth, readGuard, async (req: Request, res: Response) => {
    const r = await findColorUseCase(colorRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "اللون غير موجود" });
    }
    res.json(r.data);
  });
}
