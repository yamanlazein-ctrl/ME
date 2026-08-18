import type { IInvitationRepository, InvitationRow } from "../../../application/ports/IInvitationRepository.js";
import type { PostgresInvitationRepository } from "../../../infrastructure/repositories/PostgresInvitationRepository.js";
import type { Argon2PasswordHasher } from "../../../infrastructure/auth/PasswordHasher.js";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import { db } from "../../../infrastructure/orm/drizzle.js";
import { users } from "../../../infrastructure/orm/schemas/user.table.js";
import { deviceRegistrations } from "../../../infrastructure/orm/schemas/device-registration.table.js";
import { eq, count } from "drizzle-orm";
import { isWithinLimit } from "../../../infrastructure/http/middleware/license.enforcement.middleware.js";
import { randomBytes } from "node:crypto";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function generateInvitationCodeUseCase(
  repo: IInvitationRepository,
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
    const code = generateCode();
    const expiresAt = new Date(Date.now() + ttl * 60_000);
    const metadata: Record<string, unknown> = {};
    if (type === "user") {
      metadata.targetName = options.targetName;
      metadata.targetEmail = options.targetEmail;
      metadata.targetRole = options.targetRole;
    }
    const row = await repo.create({ tenantId, code, type, expiresAt, metadata, createdBy });
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
): Promise<Result<void>> {
  try {
    await repo.revoke(id);
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
    const lic = await licenseRepo.findLatestForTenant(row.tenantId as never);
    if (lic) {
      if (row.type === "user" && !isWithinLimit(lic.limits, "users", await countUsers(row.tenantId))) {
        return { ok: false, error: "تم الوصول إلى الحد الأقصى للمستخدمين المسموح بهم في الترخيص" };
      }
      if (row.type === "device" && !isWithinLimit(lic.limits, "devices", await countDevices(row.tenantId))) {
        return { ok: false, error: "تم الوصول إلى الحد الأقصى للأجهزة المسموح بها في الترخيص" };
      }
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
      if (!pw || pw.length < 3) {
        return { ok: false, error: "كلمة المرور مطلوبة (3 أحرف على الأقل)" };
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
    } else if (row.type === "device") {
      const fingerprint = options.deviceFingerprint ?? `auto-${Date.now()}`;
      const licenseId = (meta.licenseId as string) ?? "00000000-0000-0000-0000-000000000000";
      const d = await repoExtended.registerDevice(row.tenantId, licenseId, fingerprint);
      registeredDeviceId = d.id;
    }

    const updated = await repo.consume(row.id);
    return { ok: true, data: { ...updated, createdUserId, registeredDeviceId } };
  } catch (e) {
    return { ok: false, error: "فشل استهلاك رمز الدعوة" };
  }
}

async function countUsers(tenantId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ c }] = await db.select({ c: count() }).from(users as any).where(eq((users as any).tenantId, tenantId));
  return Number(c);
}

async function countDevices(tenantId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [{ c }] = await db.select({ c: count() }).from(deviceRegistrations as any).where(eq((deviceRegistrations as any).tenantId, tenantId));
  return Number(c);
}

function generateCode(): string {
  const bytes = randomBytes(6);
  const hex = bytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
