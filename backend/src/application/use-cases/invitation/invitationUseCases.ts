import type {
  IInvitationRepository,
  InvitationRow,
} from "../../../application/ports/IInvitationRepository.js";
import type { PostgresInvitationRepository } from "../../../infrastructure/repositories/PostgresInvitationRepository.js";
import type { Argon2PasswordHasher } from "../../../infrastructure/auth/PasswordHasher.js";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import { db } from "../../../infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { users } from "../../../infrastructure/orm/schemas/user.table.js";
import { deviceRegistrations } from "../../../infrastructure/orm/schemas/device-registration.table.js";
import { eq, count } from "drizzle-orm";
import { isWithinLimit } from "../../../infrastructure/http/middleware/license.enforcement.middleware.js";
import { resolveDeviceLimit } from "../../../domain/licensing/ownership.js";
import { randomBytes } from "node:crypto";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function generateInvitationCodeUseCase(
  repo: IInvitationRepository,
  licenseRepo: ILicenseRepository,
  tenantId: string,
  createdBy: string,
  type: "device" | "user",
  options: {
    ttlMinutes?: number;
    targetName?: string;
    targetEmail?: string;
    targetRole?: string;
  } = {},
): Promise<Result<InvitationRow>> {
  if (!["device", "user"].includes(type)) {
    return { ok: false, error: "نوع الدعوة غير صالح" };
  }
  const ttl = options.ttlMinutes ?? 15;
  if (ttl < 1 || ttl > 1440) {
    return { ok: false, error: "مدة الصلاحية يجب أن تكون بين 1 و1440 دقيقة" };
  }
  if (type === "user") {
    if (!options.targetName || !options.targetEmail || !options.targetRole) {
      return { ok: false, error: "اسم وبريد ودور المستخدم مطلوبة لدعوة المستخدم" };
    }
    const allowedRoles = ["admin", "accountant", "warehouse", "viewer"];
    if (!allowedRoles.includes(options.targetRole)) {
      return { ok: false, error: "الدور غير صالح" };
    }
  }
  try {
    // Section 5.1 — an invitation belongs to the tenant's license. Stamping it
    // here is what keeps License ↔ Invitation ↔ Device a connected chain:
    // redemption uses this id to register the accepting device, and
    // `device_registrations.license_id` is NOT NULL with an FK to `licenses.id`.
    // Without it the FK is simply never set, and redemption has to invent a
    // placeholder license id (which the FK rejects).
    const license = await runWithTenantContext({ tenantId }, () =>
      licenseRepo.findLatestForTenant(tenantId as never),
    );
    const licenseId = license?.id ?? null;
    const code = generateCode();
    const expiresAt = new Date(Date.now() + ttl * 60_000);
    const metadata: Record<string, unknown> = { licenseId };
    if (type === "user") {
      metadata.targetName = options.targetName;
      metadata.targetEmail = options.targetEmail;
      metadata.targetRole = options.targetRole;
    }
    const row = await repo.create({
      tenantId,
      licenseId,
      code,
      type,
      expiresAt,
      metadata,
      createdBy,
    });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: "فشل إنشاء رمز الدعوة" };
  }
}

export async function listInvitationCodesUseCase(
  repo: IInvitationRepository,
  tenantId: string,
): Promise<Result<InvitationRow[]>> {
  try {
    const rows = await repo.listByTenant(tenantId);
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: "فشل جلب رموز الدعوة" };
  }
}

export async function revokeInvitationCodeUseCase(
  repo: IInvitationRepository,
  id: string,
  tenantId: string,
): Promise<Result<void>> {
  try {
    const revoked = await repo.revoke(id, tenantId);
    if (!revoked) return { ok: false, error: "لم يتم العثور على رمز الدعوة" };
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: "فشل إلغاء رمز الدعوة" };
  }
}

export async function validateInvitationCodeUseCase(
  repo: IInvitationRepository,
  code: string,
): Promise<Result<InvitationRow>> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, error: "الرجاء إدخال رمز الدعوة" };
  try {
    const row = await repo.findByCode(trimmed);
    if (!row) return { ok: false, error: "رمز الدعوة غير صالح" };
    if (row.revokedAt) return { ok: false, error: "تم إلغاء رمز الدعوة" };
    if (row.expiresAt < new Date()) return { ok: false, error: "انتهت صلاحية رمز الدعوة" };
    if (row.useCount >= 1) return { ok: false, error: "تم استخدام رمز الدعوة مسبقاً" };
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: "فشل التحقق من رمز الدعوة" };
  }
}

export async function consumeInvitationCodeUseCase(
  repo: IInvitationRepository,
  repoExtended: PostgresInvitationRepository,
  licenseRepo: ILicenseRepository,
  passwordHasher: Argon2PasswordHasher,
  code: string,
  options: {
    password?: string;
    deviceFingerprint?: string;
  } = {},
): Promise<Result<InvitationRow & { createdUserId?: string; registeredDeviceId?: string }>> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, error: "الرجاء إدخال رمز الدعوة" };

  try {
    const row = await repo.findByCode(trimmed);
    if (!row) return { ok: false, error: "رمز الدعوة غير صالح" };
    if (row.revokedAt) return { ok: false, error: "تم إلغاء رمز الدعوة" };
    if (row.expiresAt < new Date()) return { ok: false, error: "انتهت صلاحية رمز الدعوة" };
    if (row.useCount >= 1) return { ok: false, error: "تم استخدام رمز الدعوة مسبقاً" };

    // Phase 5 — enforce license limits at the business layer.
    // A user invitation that carries a device fingerprint also consumes a
    // device slot ("device consumption on accept"), so the device cap must be
    // checked for device invitations AND for user invitations being accepted
    // on a device.
    // Pre-auth consume flow: no ALS context exists, so stamp the invitation's
    // tenant GUC for the license lookup (RLS category-2, own-tenant rows).
    const lic = await runWithTenantContext({ tenantId: row.tenantId }, () =>
      licenseRepo.findLatestForTenant(row.tenantId as never),
    );
    const acceptsDevice =
      row.type === "device" || (row.type === "user" && Boolean(options.deviceFingerprint));
    if (lic) {
      const effectiveLimits = {
        ...lic.limits,
        devices: resolveDeviceLimit({ limits: lic.limits, maxDevices: lic.maxDevices }),
      };
      if (
        row.type === "user" &&
        !isWithinLimit(effectiveLimits, "users", await countUsers(row.tenantId))
      ) {
        return { ok: false, error: "تم الوصول إلى الحد الأقصى للمستخدمين المسموح بهم في الترخيص" };
      }
      if (
        acceptsDevice &&
        !isWithinLimit(effectiveLimits, "devices", await countDevices(row.tenantId))
      ) {
        return { ok: false, error: "تم الوصول إلى الحد الأقصى للأجهزة المسموح بها في الترخيص" };
      }
    }

    // ── License binding for the accepting device ─────────────────────────
    // `device_registrations.license_id` is NOT NULL with an FK to
    // `licenses.id`, so a device can only ever be registered against a REAL
    // license row. Prefer the license stamped on the invitation (5.1), fall
    // back to the tenant's current license, and refuse outright when neither
    // exists. Writing a placeholder uuid instead would violate the FK today and,
    // if such a row ever existed, would silently bind the device to a license
    // that is not this tenant's — the exact cross-tenant leak section 7 forbids.
    // The check runs BEFORE any user/device row is written so a rejected
    // redemption leaves no partial state behind.
    const resolvedLicenseId: string | null =
      (lic?.id as string | undefined) ?? row.licenseId ?? null;
    if (acceptsDevice && !resolvedLicenseId) {
      return {
        ok: false,
        error: "لا يوجد ترخيص مرتبط بهذه الشركة — تعذّر تسجيل الجهاز بهذه الدعوة",
      };
    }

    const meta = row.metadata as Record<string, unknown>;
    let createdUserId: string | undefined;
    let registeredDeviceId: string | undefined;

    if (row.type === "user") {
      const targetName = meta.targetName as string | undefined;
      const targetEmail = meta.targetEmail as string | undefined;
      const targetRole = meta.targetRole as string | undefined;
      if (!targetName || !targetEmail || !targetRole) {
        return { ok: false, error: "بيانات المستخدم غير مكتملة في الدعوة" };
      }
      const pw = options.password;
      if (!pw || !/^\d{4}$/.test(pw)) {
        return { ok: false, error: "الرقم السري مطلوب (4 أرقام)" };
      }
      const hash = await passwordHasher.hash(pw);
      const u = await repoExtended.createUserFromInvitation(
        row.tenantId,
        row.id,
        targetName,
        targetEmail,
        targetRole,
        hash,
      );
      createdUserId = u.id;
      // Same PIN unlocks the device picker (pin_hash).
      await runWithTenantContext({ tenantId: row.tenantId }, async () => {
        await db
          .update(users)
          .set({ pinHash: hash, updatedAt: new Date() })
          .where(eq(users.id, u.id));
      });
      // Device consumption on accept: register the accepting device so it
      // counts against the license device cap (checked above). The license id
      // was resolved (and proven to exist) before any row was written.
      if (options.deviceFingerprint) {
        const d = await repoExtended.registerDevice(
          row.tenantId,
          resolvedLicenseId as never,
          options.deviceFingerprint,
        );
        registeredDeviceId = d.id;
      }
    } else if (row.type === "device") {
      const fingerprint = options.deviceFingerprint ?? `auto-${Date.now()}`;
      const d = await repoExtended.registerDevice(
        row.tenantId,
        resolvedLicenseId as never,
        fingerprint,
      );
      registeredDeviceId = d.id;
    }

    const updated = await repo.consume(row.id, row.tenantId);
    return { ok: true, data: { ...updated, createdUserId, registeredDeviceId } };
  } catch (e) {
    return { ok: false, error: "فشل استهلاك رمز الدعوة" };
  }
}

async function countUsers(tenantId: string): Promise<number> {
  // Pre-auth flow — stamp the tenant GUC (`users` is category-1 RLS).
  return runWithTenantContext({ tenantId }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ c }] = await db
      .select({ c: count() })
      .from(users as any)
      .where(eq((users as any).tenantId, tenantId));
    return Number(c);
  });
}

async function countDevices(tenantId: string): Promise<number> {
  // Pre-auth flow — stamp the tenant GUC (device_registrations is category-2).
  return runWithTenantContext({ tenantId }, async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [{ c }] = await db
      .select({ c: count() })
      .from(deviceRegistrations as any)
      .where(eq((deviceRegistrations as any).tenantId, tenantId));
    return Number(c);
  });
}

function generateCode(): string {
  const bytes = randomBytes(6);
  const hex = bytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
