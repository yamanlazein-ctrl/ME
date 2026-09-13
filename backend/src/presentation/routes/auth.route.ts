import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Container } from "../../infrastructure/di/container.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
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
import {
  SyncDeviceFingerprintMismatchError,
  SyncDeviceRevokedError,
} from "../../application/ports/ISyncDeviceRepository.js";
import { randomUUID } from "crypto";
import { runWithTenantContext } from "../../infrastructure/orm/tenant-context.js";
import { config } from "../../infrastructure/config/env.js";
import {
  enqueueUserMutation,
  isSyncEnqueueEnabled,
} from "../../application/use-cases/sync/syncEnqueue.js";

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

/** True when `ip` is loopback, link-local or in an IPv4/IPv6 private range.
 *  Mirrors setup.route.ts's isLocalOrPrivateLan (the desktop-SKU guard that
 *  keeps first-run provisioning on the customer's own machine/LAN). */
function isLocalOrPrivateLan(ip: string | undefined): boolean {
  if (!ip) return false;
  const host = ip.replace(/^::ffff:/, "").split(":")[0];
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  if (host.includes(".")) {
    if (host.startsWith("10.")) return true;
    if (host.startsWith("192.168.")) return true;
    if (host.startsWith("169.254.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

/**
 * Batch 4 / 4C — "is the caller a provisioned device of THIS tenant?".
 *
 * The PIN picker has to run before any session exists, so this endpoint is
 * unauthenticated by necessity. The previous version answered for ANY tenant
 * id in the query string, which let an anonymous caller enumerate a tenant's
 * users (names, emails, roles, who has a PIN set) — and, combined with the
 * equally open `pin-login`, turned that roster into a PIN-guessing target
 * list. Access now requires evidence that the caller is one of:
 *
 *   1. a live session of the tenant (Bearer access token, not denylisted,
 *      tenant match, user still active);
 *   2. the device that ACTIVATED this install — the license activation id the
 *      hub returned at activation time (stored on the device, opaque UUID,
 *      never guessable, and refused once the activation is deactivated);
 *   3. the device that redeemed an invitation for this tenant — its hardware
 *      fingerprint is on a non-revoked `device_registrations` row;
 *   4. (desktop SKU only) a caller on the machine/LAN that hosts the hub. The
 *      desktop client IS that machine, and the hub is local by design; with
 *      the tenant pinned to the baked slug above, this path can only ever
 *      expose the install's own tenant.
 *
 * Nothing here replaces authentication for real work: it only protects the
 * pre-auth picker from anonymous enumeration.
 */
async function hasDeviceProvisioningProof(
  req: Request,
  container: Container,
  tenantId: string,
  authRepo: IAuthRepository,
): Promise<boolean> {
  // 1. A live session of this tenant.
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = await container.jwtSigner.verifyAccessToken(header.slice(7));
      if (
        payload.tenantId === tenantId &&
        !(await container.tokenDenylist.has(payload.jti)) &&
        payload.type !== "refresh"
      ) {
        const user = await withJwtTenantContext(tenantId, () =>
          authRepo.findUserById(payload.sub),
        );
        if (user && user.active) return true;
      }
    } catch {
      // fall through to the device credentials
    }
  }

  // 2. The activation credential issued to this device at activation.
  const activationId = req.headers["x-device-activation-id"];
  if (typeof activationId === "string" && UUID_RE.test(activationId)) {
    try {
      const activation = await runWithTenantContext({ tenantId }, () =>
        container.licenseRepo.findActivationById(activationId),
      );
      if (activation && activation.tenantId === tenantId && !activation.deactivatedAt) return true;
    } catch {
      // fall through
    }
  }

  // 3. An invitation-provisioned device, identified by its hardware fingerprint.
  const fingerprint = req.headers["x-device-fingerprint"];
  if (typeof fingerprint === "string" && fingerprint.length >= 16 && fingerprint.length <= 128) {
    try {
      const license = await runWithTenantContext({ tenantId }, () =>
        container.licenseRepo.findLatestForTenant(tenantId as never),
      );
      if (license) {
        const devices = await runWithTenantContext({ tenantId }, () =>
          container.licenseRepo.listDevices(license.id),
        );
        if (
          devices.some((d) => d.deviceFingerprint === fingerprint && d.revokedAt === null)
        ) {
          return true;
        }
      }
    } catch {
      // fall through
    }
  }

  // 4. Desktop SKU: the picker runs on the machine (or the customer's LAN)
  //    that hosts the hub, and the tenant is already pinned to the baked slug.
  if (config.DESKTOP_DEPLOY && isLocalOrPrivateLan(req.ip ?? req.socket?.remoteAddress)) {
    return true;
  }

  return false;
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

      // Reuse detection: a refresh token that is ALREADY denylisted has either
      // been rotated away (normal, single-use) or explicitly revoked. Seeing it
      // again means a captured copy is being replayed, or two clients are racing
      // on one session — neither may mint a new token pair.
      //
      // The response code stays TOKEN_EXPIRED on purpose: clients treat it as a
      // definitive auth failure and clear the stored session. A new code here
      // would make them retry forever.
      if (await container.tokenDenylist.has(payload.jti)) {
        console.warn(
          `[auth] refresh reuse detected — jti=${payload.jti} sub=${payload.sub} tenant=${payload.tenantId}`,
        );
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

      // Rotation is single-use: retire the presented refresh token with its own
      // remaining lifetime. Without this the old token stayed valid for the rest
      // of the 365-day refresh window, so a captured copy could be replayed
      // indefinitely. Done before responding so a client can never hold a fresh
      // pair while the old one is still live.
      const previousTtlSeconds = Math.max(0, Math.floor((payload.exp! * 1000 - Date.now()) / 1000));
      if (previousTtlSeconds > 0) {
        await container.tokenDenylist.add(payload.jti, previousTtlSeconds, {
          reason: "rotated",
          subject: payload.sub,
          tenantId: payload.tenantId,
        });
      }

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
      // ── Batch 4 / 4C hardening ─────────────────────────────────────────
      // This endpoint is pre-auth by necessity (it drives the PIN picker), so
      // it cannot rely on the shared auth middleware. Two rules replace the
      // previous "any tenant id in the query string" behaviour:
      //
      //  1. An operator-pinned install (BOOTSTRAP_TENANT_ID) serves exactly
      //     that tenant. A completed install that is only known through the
      //     wizard resolves the same way the install gate does.
      //  2. The caller must PROVE it is a provisioned device of that tenant —
      //     a live session, or the activation/invite credential the device
      //     received when it was provisioned, or (desktop SKU only) a request
      //     from the machine/LAN that hosts the hub. Without proof the roster
      //     is not disclosed at all.
      if (!config.DESKTOP_DEPLOY) {
        const pinned = process.env.BOOTSTRAP_TENANT_ID;
        if (pinned && pinned !== tenantId) {
          return res.status(403).json({
            code: "ROSTER_TENANT_MISMATCH",
            message: "قائمة المستخدمين متاحة لشركة هذا التثبيت فقط",
          });
        }
      }
      const state = await container.installationStateRepo.findByTenant(tenantId);
      if (!state?.isCompleted) {
        return res
          .status(503)
          .json({ code: "SETUP_REQUIRED", message: "يرجى إكمال معالج الإعداد" });
      }
      const proof = await hasDeviceProvisioningProof(req, container, tenantId, authRepo);
      if (!proof) {
        return res.status(401).json({
          code: "DEVICE_PROOF_REQUIRED",
          message: "تعذّر التحقق من تفعيل هذا الجهاز — أعد تفعيل الجهاز ثم حاول مجدداً",
          statusCode: 401,
        });
      }
      const list = await authRepo.listActiveUsersForTenant(tenantId);
      res.status(200).json({ tenantId, users: list });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/api/auth/pin-login",
    loginRateLimiter,
    validateBody(PinLoginSchema),
    async (req, res, next) => {
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
    },
  );

  router.post(
    "/api/auth/set-pin",
    loginRateLimiter,
    validateBody(SetPinSchema),
    async (req, res, next) => {
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
        if (isSyncEnqueueEnabled()) {
          const ctx = {
            tenantId,
            userId,
            userName: user.name,
            userRole: user.role as "admin" | "accountant" | "warehouse" | "viewer",
          };
          const snapshot = await container.userRepo.findSyncSnapshot(userId, ctx);
          if (snapshot) {
            await enqueueUserMutation(
              container.syncOutboxRepo,
              snapshot,
              "set-pin",
              ctx,
              null,
            );
          }
        }
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/api/auth/sync-device",
    validateBody(SyncDeviceRegisterSchema),
    async (req, res, next) => {
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
        // 4B revoked user: this route verifies the token itself (it is outside
        // the shared auth middleware), so it must apply the same "the session
        // belongs to a live user" rule — a deactivated user must not be able to
        // (re)bind a device to themselves.
        const user = await withJwtTenantContext(payload.tenantId, () =>
          authRepo.findUserById(payload.sub),
        );
        if (!user || !user.active) {
          return res.status(401).json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية الجلسة" });
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
          deviceId: body.deviceId,
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
        // 4B device trust: distinct, non-generic refusals so the device can
        // tell "someone else owns this id" from "an operator revoked me"
        // from a plain validation error.
        if (err instanceof SyncDeviceRevokedError) {
          return res.status(403).json({
            code: "SYNC_DEVICE_REVOKED",
            message: err.message,
            statusCode: 403,
          });
        }
        if (err instanceof SyncDeviceFingerprintMismatchError) {
          return res.status(403).json({
            code: "SYNC_DEVICE_FINGERPRINT_MISMATCH",
            message: err.message,
            statusCode: 403,
          });
        }
        next(err);
      }
    },
  );
}
