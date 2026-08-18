import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createPartySchema, updatePartySchema, listPartiesSchema } from "./party.schema.js";
import {
  createPartyUseCase,
  updatePartyUseCase,
  findPartyUseCase,
  listPartiesUseCase,
  cancelPartyUseCase,
} from "../../application/use-cases/parties/partyUseCases.js";

export function registerPartyRoutes(
  router: Router,
  partyRepo: IPartyRepository,
  auth: RequestHandler,
  accountantAndUp: RequestHandler,
  readAll: RequestHandler,
) {
  const ctxFn = (req: Request): TenantContext => req.tenantContext!;
  const paramId = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/customers",
    auth,
    accountantAndUp,
    validateBody(createPartySchema.omit({ kind: true })),
    async (req: Request, res: Response) => {
      const input = { ...body<Record<string, unknown>>(req), kind: "customer" as const };
      const result = await createPartyUseCase(
        partyRepo,
        input as Parameters<typeof createPartyUseCase>[1],
        ctxFn(req),
      );
      if (result.ok) return res.status(201).json(result.data);
      return res.status(422).json({ code: "VALIDATION", message: result.error });
    },
  );

  router.post(
    "/suppliers",
    auth,
    accountantAndUp,
    validateBody(createPartySchema.omit({ kind: true })),
    async (req: Request, res: Response) => {
      const input = { ...body<Record<string, unknown>>(req), kind: "supplier" as const };
      const result = await createPartyUseCase(
        partyRepo,
        input as Parameters<typeof createPartyUseCase>[1],
        ctxFn(req),
      );
      if (result.ok) return res.status(201).json(result.data);
      return res.status(422).json({ code: "VALIDATION", message: result.error });
    },
  );

  router.get(
    "/parties",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(partyRepo, filter, ctxFn(req));
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get(
    "/customers",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(
        partyRepo,
        { ...filter, kind: "customer" },
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get(
    "/suppliers",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(
        partyRepo,
        { ...filter, kind: "supplier" },
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get("/parties/:id", auth, readAll, validateUuidParam("id"), async (req: Request, res: Response) => {
    const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
    if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
    if (!result.data)
      return res.status(404).json({ code: "NOT_FOUND", message: "الطرف غير موجود" });
    return res.json(result.data);
  });

  router.get("/customers/:id", auth, readAll, validateUuidParam("id"), async (req: Request, res: Response) => {
    const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
    if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
    if (!result.data || result.data.kind !== "customer") {
      return res.status(404).json({ code: "NOT_FOUND", message: "العميل غير موجود" });
    }
    return res.json(result.data);
  });

  router.get("/suppliers/:id", auth, readAll, validateUuidParam("id"), async (req: Request, res: Response) => {
    const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
    if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
    if (!result.data || result.data.kind !== "supplier") {
      return res.status(404).json({ code: "NOT_FOUND", message: "المورد غير موجود" });
    }
    return res.json(result.data);
  });

  router.put(
    "/customers/:id",
    auth,
    accountantAndUp,
    validateBody(updatePartySchema),
    async (req: Request, res: Response) => {
      const result = await updatePartyUseCase(
        partyRepo,
        paramId(req),
        body<Record<string, unknown>>(req) as Record<string, unknown>,
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(422).json({ code: "VALIDATION", message: result.error });
    },
  );

  router.put(
    "/suppliers/:id",
    auth,
    accountantAndUp,
    validateBody(updatePartySchema),
    async (req: Request, res: Response) => {
      const result = await updatePartyUseCase(
        partyRepo,
        paramId(req),
        body<Record<string, unknown>>(req) as Record<string, unknown>,
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(422).json({ code: "VALIDATION", message: result.error });
    },
  );

  router.delete("/customers/:id", auth, accountantAndUp, validateUuidParam("id"), async (req: Request, res: Response) => {
    const ctx = ctxFn(req);
    const result = await cancelPartyUseCase(partyRepo, paramId(req), ctx.userId, ctx);
    if (result.ok) return res.status(204).end();
    return res.status(422).json({ code: "VALIDATION", message: result.error });
  });

  router.delete("/suppliers/:id", auth, accountantAndUp, validateUuidParam("id"), async (req: Request, res: Response) => {
    const ctx = ctxFn(req);
    const result = await cancelPartyUseCase(partyRepo, paramId(req), ctx.userId, ctx);
    if (result.ok) return res.status(204).end();
    return res.status(422).json({ code: "VALIDATION", message: result.error });
  });
}
