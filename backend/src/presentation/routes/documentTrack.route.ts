import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateQuery } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { PostgresDocumentTrackRepository } from "../../infrastructure/repositories/PostgresDocumentTrackRepository.js";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const documentTrackQuerySchema = z.object({
  type: z
    .enum(["all", "entry", "sale", "return", "print_send", "print_receive", "settlement"])
    .optional(),
  status: z.enum(["all", "active", "cancelled", "draft"]).optional(),
  partyId: z.string().uuid().optional(),
  fromDate: ymd.optional(),
  toDate: ymd.optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

/** GET /api/documents/track — invoice-tracking screen, paged on the server. */
export function registerDocumentTrackRoutes(
  router: Router,
  repo: PostgresDocumentTrackRepository,
  auth: RequestHandler,
  readGuard: RequestHandler,
) {
  router.get(
    "/documents/track",
    auth,
    readGuard,
    validateQuery(documentTrackQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const q = req.validatedQuery as z.infer<typeof documentTrackQuerySchema>;
        res.json(await repo.list(q, req.tenantContext!));
      } catch (err) {
        res.status(500).json({ code: "INTERNAL", message: (err as Error).message });
      }
    },
  );
}
