import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Container } from "../../infrastructure/di/container.js";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { LoginSchema, RefreshTokenSchema } from "./auth.schema.js";
import { InvalidCredentialsError } from "../../domain/errors/index.js";
import { randomUUID } from "crypto";

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

      const user = await authRepo.findUserById(payload.sub);
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
        const { email, password, tenantId } = req.validatedBody as z.infer<typeof LoginSchema>;
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
      const payload = await container.jwtSigner.verify(refreshToken);

      if (payload.type !== "refresh") {
        return res.status(401).json({ code: "UNAUTHORIZED", message: "رمز التجديد غير صالح" });
      }

      if (await container.tokenDenylist.has(payload.jti)) {
        return res.status(401).json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة" });
      }

      const user = await authRepo.findUserById(payload.sub);
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
}
