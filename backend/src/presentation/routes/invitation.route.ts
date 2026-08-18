import { Router } from "express";
import type { Container } from "../../infrastructure/di/container.js";
import {
  generateInvitationCodeUseCase,
  listInvitationCodesUseCase,
  revokeInvitationCodeUseCase,
  validateInvitationCodeUseCase,
  consumeInvitationCodeUseCase,
} from "../../application/use-cases/invitation/invitationUseCases.js";
import type { PostgresInvitationRepository } from "../../infrastructure/repositories/PostgresInvitationRepository.js";

export function registerInvitationAdminRoutes(
  router: Router,
  container: Container,
  authMiddleware: ReturnType<
    typeof import("../../infrastructure/http/middleware/auth.middleware.js").createAuthMiddleware
  >,
  adminGuard: ReturnType<
    typeof import("../../infrastructure/http/middleware/rbac.middleware.js").rbac
  >,
): void {
  router.post("/api/invitations/generate", authMiddleware, adminGuard, async (req, res, next) => {
    try {
      const ctx = (req as unknown as { tenantContext?: { tenantId?: string; userId?: string } })
        .tenantContext;
      const tenantId = ctx?.tenantId ?? "bootstrap";
      const createdBy = ctx?.userId ?? "system";
      const r = await generateInvitationCodeUseCase(
        container.invitationRepo,
        tenantId,
        createdBy,
        String(req.body.type ?? "device") as "device" | "user",
        {
          ttlMinutes: Number(req.body.ttlMinutes ?? 15),
          targetName: req.body.targetName as string | undefined,
          targetEmail: req.body.targetEmail as string | undefined,
          targetRole: req.body.targetRole as string | undefined,
        },
      );
      if (!r.ok) {
        res.status(422).json({ message: r.error });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/invitations/list", authMiddleware, adminGuard, async (req, res, next) => {
    try {
      const ctx = (req as unknown as { tenantContext?: { tenantId?: string } }).tenantContext;
      const tenantId = ctx?.tenantId ?? "bootstrap";
      const r = await listInvitationCodesUseCase(container.invitationRepo, tenantId);
      if (!r.ok) {
        res.status(500).json({ message: r.error });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/invitations/revoke/:id", authMiddleware, adminGuard, async (req, res, next) => {
    try {
      const r = await revokeInvitationCodeUseCase(container.invitationRepo, String(req.params.id));
      if (!r.ok) {
        res.status(422).json({ message: r.error });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

export function registerInvitationPublicRoutes(router: Router, container: Container): void {
  router.post("/api/invitations/validate", async (req, res, next) => {
    try {
      const r = await validateInvitationCodeUseCase(
        container.invitationRepo,
        String(req.body.code ?? ""),
      );
      if (!r.ok) {
        res.status(400).json({ message: r.error });
        return;
      }
      res.json({ valid: true, type: r.data.type, tenantId: r.data.tenantId });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/invitations/consume", async (req, res, next) => {
    try {
      const repo = container.invitationRepo as PostgresInvitationRepository;
      const r = await consumeInvitationCodeUseCase(
        container.invitationRepo,
        repo,
        container.licenseRepo,
        container.passwordHasher,
        String(req.body.code ?? ""),
        {
          password: req.body.password as string | undefined,
          deviceFingerprint: req.body.deviceFingerprint as string | undefined,
        },
      );
      if (!r.ok) {
        res.status(400).json({ message: r.error });
        return;
      }
      res.json({
        consumed: true,
        type: r.data.type,
        tenantId: r.data.tenantId,
        createdUserId: r.data.createdUserId,
        registeredDeviceId: r.data.registeredDeviceId,
      });
    } catch (err) {
      next(err);
    }
  });
}
