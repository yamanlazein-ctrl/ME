import type { Router, Request, Response, RequestHandler } from "express";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { INotificationRepository } from "../../application/ports/INotificationRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import * as uc from "../../application/use-cases/notifications/notificationUseCases.js";

export function registerNotificationRoutes(
  router: Router,
  notifRepo: INotificationRepository,
  auth: RequestHandler,
  readGuard: RequestHandler,
  writeGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  // Internal/admin endpoint for creating a notification (used by tests + automation).
  // The schema is validated inline to avoid a schema file for a single dev/test route.
  router.post("/notifications", auth, writeGuard, async (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const detail = typeof raw.detail === "string" ? raw.detail : undefined;
    const kind = typeof raw.kind === "string" ? raw.kind : "info";
    const severity = typeof raw.severity === "string" ? raw.severity : "info";
    const targetPath = typeof raw.targetPath === "string" ? raw.targetPath : undefined;
    if (!title || title.length > 255) {
      return res.status(422).json({ code: "VALIDATION", message: "العنوان مطلوب (1-255 حرف)" });
    }
    const allowedKinds = new Set(["info", "warning", "critical", "success"]);
    const allowedSeverities = new Set(["info", "warning", "critical", "success"]);
    if (!allowedKinds.has(kind)) {
      return res.status(422).json({ code: "VALIDATION", message: "kind غير صالح" });
    }
    if (!allowedSeverities.has(severity)) {
      return res.status(422).json({ code: "VALIDATION", message: "severity غير صالح" });
    }
    const r = await uc.createNotificationUseCase(notifRepo, {
      title, detail, kind: kind as never, severity: severity as never, targetPath,
    }, ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    res.status(201).json(r.data);
  });

  router.get("/notifications", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listNotificationsUseCase(notifRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get(
    "/notifications/unread-count",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const r = await uc.getUnreadCountUseCase(notifRepo, ctx(req));
      if (r.ok) {
        res.json({ count: r.data });
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.post("/notifications/:id/read", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.markReadUseCase(notifRepo, pid(req), ctx(req));
    if (r.ok) {
      res.json({ ok: true });
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.post(
    "/notifications/mark-all-read",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const r = await uc.markAllReadUseCase(notifRepo, ctx(req));
      if (r.ok) {
        res.json({ ok: true });
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.post(
    "/notifications/dismiss-all",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const r = await uc.dismissAllUseCase(notifRepo, ctx(req));
      if (r.ok) {
        res.json({ ok: true });
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );
}
