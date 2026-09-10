import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Container } from "../../infrastructure/di/container.js";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import {
  LoginSchema,
  RefreshTokenSchema,
  DeviceRosterSchema,
  PinLoginSchema,
  SetPinSchema,
  SyncDeviceRegisterSchema,
} from "./auth.schema.js";
import { InvalidCredentialsError } from "../../domain/errors/index.js";
import { randomUUID } from "crypto";
import { runWithTenantContext } from "../../infrastructure/orm/tenant-context.js";
import { config } from "../../infrastructure/config/env.js";

// Login-specific rate limiter: 5 attempts per IP per 15 minutes
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.ip ?? "unknown") + (req.body?.email ?? ""),
  handler: (_req, res) => {
    res.status(429).json({
      code: "RATE_LIMIT_EXCEEDED",
      message: "تم تجاوز عدد محاولات تسجيل الدخول المسموح بها. يرجى المحاولة بعد 15 دقيقة",
      statusCode: 429,
    });
  },
});

// `/api/auth/me` and `/api/auth/refresh` verify the token themselves (they are
// not behind the shared auth middleware), so they must establish the RLS
// tenant context before `findUserById` touches the tenant-scoped `users`
// table. The tenant id comes from the ALREADY-VERIFIED JWT, never from the
// request body. The super-admin realm mints tokens with the non-UUID
// "system" sentinel — those must never be fed into the uuid GUC, so they run
// without a tenant context (the users lookup then sees no rows → 401, which
// is correct: super-admins are not tenant users).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withJwtTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  if (UUID_RE.test(tenantId)) {
    return runWithTenantContext({ tenantId }, fn);
  }
  return fn();
}

export function registerAuthRoutes(router: Router, container: Container) {
  const authRepo = container.authRepo;

  router.get("/api/auth/me", async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول" });
      }
      const token = header.slice(7);
      const payload = await container.jwtSigner.verifyAccessToken(token);

      const revoked = await container.tokenDenylist.has(payload.jti);
      if (revoked) {
        return res.status(401).json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة" });
      }

      const user = await withJwtTenantContext(payload.tenantId, () =>
        authRepo.findUserById(payload.sub),
      );
      if (!user || !user.active) {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "المستخدم غير موجود" });
      }

      res.status(200).json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        permissions: [],
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/api/auth/login",
    loginRateLimiter,
    validateBody(LoginSchema),
    async (req, res, next) => {
      try {
        let { email, password, tenantId } = req.validatedBody as z.infer<typeof LoginSchema>;
        // Desktop SKU is one install = one tenant. Wizard leftovers may have
        // stored a random tenant id from a failed first Continue; ignore it
        // and always authenticate against the seeded slug=`default` tenant.
        if (config.DESKTOP_DEPLOY) {
          const baked = await container.tenantRepo.findBySlug("default");
          if (baked) tenantId = baked.id;
        }
        // Host-based tenant resolution as fallback (e.g., customer1.motard.com → tenant lookup)
        // For now, require explicit tenantId; host fallback is a future enhancement
        // to avoid unordered LIMIT 1 when email is not globally unique.
        if (!tenantId) {
          const host = (req.headers.host as string | undefined) ?? "";
          // Simple host→tenant mapping could be added here (e.g., via tenants.slug)
          // For now, fail fast with clear message instead of picking arbitrary tenant
          throw new InvalidCredentialsError();
        }
        const user = await authRepo.findUserByEmail(email, tenantId);

        if (!user || !user.active) {
          throw new InvalidCredentialsError();
        }

        const valid = await container.passwordHasher.verify(user.passwordHash, password);
        if (!valid) {
          throw new InvalidCredentialsError();
        }

        const jti = randomUUID();
        const payload = {
          sub: user.id,
          tenantId: user.tenantId,
          role: user.role,
          jti,
        };

        const accessToken = await container.jwtSigner.signAccessToken(payload);
        const refreshToken = await container.jwtSigner.signRefreshToken({
          ...payload,
          jti: randomUUID(),
        });

        res.status(200).json({
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/api/auth/refresh", validateBody(RefreshTokenSchema), async (req, res, next) => {
    try {
      const { refreshToken } = req.validatedBody as z.infer<typeof RefreshTokenSchema>;
      let payload;
      try {
        payload = await container.jwtSigner.verify(refreshToken);
      } catch {
        // Issue 18: invalid/expired refresh must be 401 (not 500) so clients can clear session.
        return res.status(401).json({ code: "UNAUTHORIZED", message: "رمز التجديد غير صالح" });
      }

      if (payload.type !== "refresh") {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "رمز التجديد غير صالح" });
      }

      if (await container.tokenDenylist.has(payload.jti)) {
        return res.status(401).json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة" });
      }

      const user = await withJwtTenantContext(payload.tenantId, () =>
        authRepo.findUserById(payload.sub),
      );
      if (!user || !user.active) {
        throw new InvalidCredentialsError();
      }

      const jti = randomUUID();
      const newPayload = {
        sub: user.id,
        tenantId: user.tenantId,
        role: user.role,
        jti,
      };

      const newAccessToken = await container.jwtSigner.signAccessToken(newPayload);
      const newRefreshToken = await container.jwtSigner.signRefreshToken({
        ...newPayload,
        jti: randomUUID(),
      });

      res.status(200).json({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/auth/logout", async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        const token = header.slice(7);
        try {
          const payload = await container.jwtSigner.verifyAccessToken(token);
          const ttl = Math.max(0, Math.floor((payload.exp! * 1000 - Date.now()) / 1000));
          if (ttl > 0) {
            await container.tokenDenylist.add(payload.jti, ttl);
          }
        } catch {
          // Ignore invalid token on logout
        }
      }
      // Also revoke the refresh token if provided in the body
      const { refreshToken } = req.body ?? {};
      if (refreshToken) {
        try {
          const payload = await container.jwtSigner.verify(refreshToken);
          if (payload.type === "refresh") {
            const ttl = Math.max(0, Math.floor((payload.exp! * 1000 - Date.now()) / 1000));
            if (ttl > 0) {
              await container.tokenDenylist.add(payload.jti, ttl);
            }
          }
        } catch {
          // Ignore invalid refresh token on logout
        }
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // Device user roster — public after install complete (for PIN picker UI).
  router.get("/api/auth/device-roster", async (req, res, next) => {
    try {
      const parsed = DeviceRosterSchema.safeParse({
        tenantId: typeof req.query.tenantId === "string" ? req.query.tenantId : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({ code: "VALIDATION", message: "tenantId مطلوب" });
      }
      let tenantId = parsed.data.tenantId;
      if (config.DESKTOP_DEPLOY) {
        const baked = await container.tenantRepo.findBySlug("default");
        if (baked) tenantId = baked.id;
      }
      const state = await container.installationStateRepo.findByTenant(tenantId);
      if (!state?.isCompleted) {
        return res.status(503).json({ code: "SETUP_REQUIRED", message: "يرجى إكمال معالج الإعداد" });
      }
      const list = await authRepo.listActiveUsersForTenant(tenantId);
      res.status(200).json({ tenantId, users: list });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/auth/pin-login", loginRateLimiter, validateBody(PinLoginSchema), async (req, res, next) => {
    try {
      let { userId, pin, tenantId } = req.validatedBody as z.infer<typeof PinLoginSchema>;
      if (config.DESKTOP_DEPLOY) {
        const baked = await container.tenantRepo.findBySlug("default");
        if (baked) tenantId = baked.id;
      }
      if (!tenantId) throw new InvalidCredentialsError();
      const user = await authRepo.findUserByIdForAuth(userId, tenantId);
      if (!user || !user.active || !user.pinHash) throw new InvalidCredentialsError();
      const valid = await container.passwordHasher.verify(user.pinHash, pin);
      if (!valid) throw new InvalidCredentialsError();

      const jti = randomUUID();
      const payload = { sub: user.id, tenantId: user.tenantId, role: user.role, jti };
      const accessToken = await container.jwtSigner.signAccessToken(payload);
      const refreshToken = await container.jwtSigner.signRefreshToken({
        ...payload,
        jti: randomUUID(),
      });
      res.status(200).json({
        accessToken,
        refreshToken,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/auth/set-pin", loginRateLimiter, validateBody(SetPinSchema), async (req, res, next) => {
    try {
      let { userId, pin, currentSecret, tenantId } = req.validatedBody as z.infer<
        typeof SetPinSchema
      >;
      if (config.DESKTOP_DEPLOY) {
        const baked = await container.tenantRepo.findBySlug("default");
        if (baked) tenantId = baked.id;
      }
      if (!tenantId) throw new InvalidCredentialsError();
      const user = await authRepo.findUserByIdForAuth(userId, tenantId);
      if (!user || !user.active) throw new InvalidCredentialsError();

      const passwordOk = await container.passwordHasher.verify(user.passwordHash, currentSecret);
      const pinOk = user.pinHash
        ? await container.passwordHasher.verify(user.pinHash, currentSecret)
        : false;
      if (!passwordOk && !pinOk) throw new InvalidCredentialsError();

      const pinHash = await container.passwordHasher.hash(pin);
      await authRepo.setPinHash(userId, tenantId, pinHash);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/auth/sync-device", validateBody(SyncDeviceRegisterSchema), async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "الجلسة غير صالحة" });
      }
      const token = header.slice(7);
      const payload = await container.jwtSigner.verifyAccessToken(token);
      const revoked = await container.tokenDenylist.has(payload.jti);
      if (revoked || !UUID_RE.test(payload.tenantId)) {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "الجلسة غير صالحة" });
      }
      const body = req.validatedBody as z.infer<typeof SyncDeviceRegisterSchema>;
      const row = await container.syncDeviceRepo.registerOrTouch({
        tenantId: payload.tenantId,
        userId: payload.sub,
        deviceFingerprint: body.deviceFingerprint,
        deviceFingerprintVersion: body.deviceFingerprintVersion ?? 1,
        platform: body.platform,
        hostname: body.hostname,
        label: body.label,
      });
      res.status(200).json({
        id: row.id,
        tenantId: row.tenantId,
        lastSeenByUserId: row.lastSeenByUserId,
        deviceFingerprint: row.deviceFingerprint,
        deviceFingerprintVersion: row.deviceFingerprintVersion,
        platform: row.platform,
        hostname: row.hostname,
        label: row.label,
        lastSeenAt: row.lastSeenAt,
      });
    } catch (err) {
      next(err);
    }
  });
}
