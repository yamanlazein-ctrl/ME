/**
 * Hub side of device enrollment: a company admin issues ONE short code; each
 * device redeems it once to get its own sync identity (its local device id,
 * registered here) and its own credential. Employees never see the hub
 * account. The device later trades that credential for hub tokens
 * (`exchangeDeviceToken`), so a revoked device stops at the next token.
 *
 * Storage: the existing encrypted `secrets` table, tenant-scoped — no schema
 * change. `sync.enroll.current` holds the company's live code (a new code
 * replaces it); `sync.device.cred.<deviceId>` holds sha256(device secret) and
 * the user the device acts for (the admin who issued the code).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ISecretsRepository } from "../../ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../ports/ISecretCipher.js";
import type { ISyncDeviceRepository } from "../../ports/ISyncDeviceRepository.js";
import type { ILicenseRepository } from "../../ports/ILicenseRepository.js";
import type { ITenantRepository } from "../../ports/ITenantRepository.js";
import type { JwtSigner } from "../../../infrastructure/auth/JwtSigner.js";
import { resolveDeviceLimit } from "../../../domain/licensing/ownership.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { resolveSessionIdentity } from "../../../infrastructure/auth/sessionCutoff.js";
import { assertTenantLicenseAllowsAccess } from "../../../infrastructure/license/tenantLicenseAccess.js";

export type EnrollmentDeps = {
  secretsRepo: ISecretsRepository;
  secretCipher: ISecretCipher;
  syncDeviceRepo: ISyncDeviceRepository;
  licenseRepo: ILicenseRepository;
  tenantRepo: ITenantRepository;
  jwtSigner: JwtSigner;
};

export type EnrollingDevice = {
  id: string;
  fingerprint: string;
  fingerprintVersion?: number;
  platform: string;
  hostname?: string | null;
  label?: string | null;
};

export type EnrollmentCodeInfo = { code: string; expiresAt: string; maxUses: number; uses: number };

type CodeRecord = EnrollmentCodeInfo & { codeHash: string; createdBy: string };
type CredRecord = { hash: string; userId: string };

export type Failure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): Failure => ({ ok: false, status, code, error });

export type HubTokens = {
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; role: string };
};

const CURRENT_KEY = "sync.enroll.current";
const credKey = (deviceId: string) => `sync.device.cred.${deviceId}`;
// No 0/O/1/I: the code is read aloud and typed by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalizeEnrollmentCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 12 characters (~60 bits), shown as XXXX-XXXX-XXXX. */
export function newEnrollmentCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

async function readJson<T>(deps: EnrollmentDeps, tenantId: string, key: string): Promise<T | null> {
  const rec = await deps.secretsRepo.get(tenantId, key);
  return rec ? (JSON.parse(await deps.secretCipher.decrypt(rec)) as T) : null;
}

const putJson = (deps: EnrollmentDeps, tenantId: string, key: string, value: unknown) =>
  deps.secretsRepo.put(tenantId, key, JSON.stringify(value));

export async function createEnrollmentCode(
  deps: EnrollmentDeps,
  tenantId: string,
  createdBy: string,
  opts: { ttlHours?: number; maxUses?: number } = {},
): Promise<EnrollmentCodeInfo> {
  const code = newEnrollmentCode();
  const rec: CodeRecord = {
    code,
    codeHash: sha256(normalizeEnrollmentCode(code)),
    expiresAt: new Date(Date.now() + (opts.ttlHours ?? 72) * 3_600_000).toISOString(),
    maxUses: opts.maxUses ?? 25,
    uses: 0,
    createdBy,
  };
  await putJson(deps, tenantId, CURRENT_KEY, rec);
  return { code, expiresAt: rec.expiresAt, maxUses: rec.maxUses, uses: 0 };
}

export async function getEnrollmentCode(deps: EnrollmentDeps, tenantId: string): Promise<EnrollmentCodeInfo | null> {
  const rec = await readJson<CodeRecord>(deps, tenantId, CURRENT_KEY);
  return rec ? { code: rec.code, expiresAt: rec.expiresAt, maxUses: rec.maxUses, uses: rec.uses } : null;
}

export const revokeEnrollmentCode = (deps: EnrollmentDeps, tenantId: string) =>
  deps.secretsRepo.delete(tenantId, CURRENT_KEY);

async function activeUser(tenantId: string, userId: string) {
  const ident = await runWithTenantContext({ tenantId }, () => resolveSessionIdentity(userId, userId));
  return ident.known && ident.active && ident.role ? { name: ident.name ?? userId, role: ident.role } : null;
}

async function issueTokens(deps: EnrollmentDeps, tenantId: string, userId: string, name: string, role: string): Promise<HubTokens> {
  const payload = { sub: userId, tenantId, role, jti: randomUUID() };
  return {
    tenantId,
    accessToken: await deps.jwtSigner.signAccessToken(payload),
    refreshToken: await deps.jwtSigner.signRefreshToken({ ...payload, jti: randomUUID() }),
    user: { id: userId, name, role },
  };
}

/** New random secret for a device; only its hash is kept. */
async function mintCredential(deps: EnrollmentDeps, tenantId: string, deviceId: string, userId: string): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await putJson(deps, tenantId, credKey(deviceId), { hash: sha256(secret), userId } satisfies CredRecord);
  return secret;
}

/** Public: a device presents the company code and receives its identity + credential + tokens. */
export async function redeemEnrollmentCode(
  deps: EnrollmentDeps,
  tenantId: string,
  code: string,
  device: EnrollingDevice,
): Promise<({ ok: true; deviceId: string; deviceSecret: string } & HubTokens) | Failure> {
  const rec = await readJson<CodeRecord>(deps, tenantId, CURRENT_KEY);
  if (!rec || !sameHash(sha256(normalizeEnrollmentCode(code)), rec.codeHash)) {
    return fail(401, "ENROLL_CODE_INVALID", "رمز التسجيل غير صحيح");
  }
  if (Date.parse(rec.expiresAt) <= Date.now()) return fail(410, "ENROLL_CODE_EXPIRED", "انتهت صلاحية رمز التسجيل — اطلب رمزاً جديداً من المسؤول");
  if (rec.uses >= rec.maxUses) return fail(410, "ENROLL_CODE_USED_UP", "استُنفد عدد مرات استخدام رمز التسجيل — اطلب رمزاً جديداً");

  try {
    await assertTenantLicenseAllowsAccess({ licenseRepo: deps.licenseRepo, tenantRepo: deps.tenantRepo, tenantId });
  } catch (e) {
    return fail(403, "LICENSE_BLOCKED", e instanceof Error ? e.message : "ترخيص المركز لا يسمح بالتسجيل");
  }
  const lic = await deps.licenseRepo.findActiveForTenant(tenantId as never);
  if (!lic) return fail(403, "NO_LICENSE", "لا يوجد ترخيص نشط في المركز");

  const existing = await deps.syncDeviceRepo.findById(tenantId as never, device.id as never);
  if (existing?.revokedAt) return fail(403, "SYNC_DEVICE_REVOKED", "هذا الجهاز معطَّل في المركز — يجب أن يعيد المسؤول تفعيله");
  if (!existing) {
    // ponytail: count-then-insert, two simultaneous enrollments can pass one
    // over the limit; a per-tenant lock if that ever matters.
    const live = (await deps.syncDeviceRepo.listForTenant(tenantId as never, 500)).filter((d) => !d.revokedAt);
    const limit = resolveDeviceLimit({ limits: lic.limits, maxDevices: lic.maxDevices });
    if (live.length >= limit) {
      return fail(403, "DEVICE_LIMIT", `تم الوصول إلى الحد الأقصى للأجهزة في الترخيص (${limit})`);
    }
  }

  const issuer = await activeUser(tenantId, rec.createdBy);
  if (!issuer) return fail(403, "ENROLL_ISSUER_INACTIVE", "حساب المسؤول الذي أصدر الرمز لم يعد فعّالاً — اطلب رمزاً جديداً");

  let row;
  try {
    row = await deps.syncDeviceRepo.registerOrTouch({
      tenantId: tenantId as never,
      userId: rec.createdBy as never,
      deviceFingerprint: device.fingerprint,
      deviceFingerprintVersion: device.fingerprintVersion ?? 1,
      platform: device.platform,
      hostname: device.hostname ?? null,
      label: device.label ?? device.hostname ?? null,
      deviceId: device.id as never,
    });
  } catch (e) {
    return fail(403, "SYNC_DEVICE_REFUSED", e instanceof Error ? e.message : "تعذّر تسجيل الجهاز");
  }
  // Pushes carry the LOCAL id; a hub row under another id would refuse them all.
  if (row.id !== device.id) {
    return fail(409, "SYNC_DEVICE_ID_CONFLICT", "المركز يعرف هذا الجهاز بمعرّف آخر — عطّل الجهاز القديم من قائمة الأجهزة ثم أعد التسجيل");
  }

  const deviceSecret = await mintCredential(deps, tenantId, row.id, rec.createdBy);
  // ponytail: read-modify-write; a simultaneous redeem can be counted once.
  await putJson(deps, tenantId, CURRENT_KEY, { ...rec, uses: rec.uses + 1 });
  const tokens = await issueTokens(deps, tenantId, rec.createdBy, issuer.name, issuer.role);
  return { ok: true, deviceId: row.id, deviceSecret, ...tokens };
}

/** Authenticated: a device paired with an account converts that pairing into a device credential. */
export async function mintCredentialForBoundDevice(
  deps: EnrollmentDeps,
  tenantId: string,
  deviceId: string,
  userId: string,
): Promise<{ ok: true; deviceSecret: string } | Failure> {
  const device = await deps.syncDeviceRepo.findById(tenantId as never, deviceId as never);
  if (!device) return fail(404, "SYNC_UNKNOWN_DEVICE", "الجهاز غير مسجّل في المركز");
  if (device.revokedAt) return fail(403, "SYNC_DEVICE_REVOKED", "الجهاز معطَّل في المركز");
  if (!device.authorizedUserIds.includes(userId)) return fail(403, "SYNC_DEVICE_NOT_BOUND", "الجهاز غير مرتبط بهذا الحساب");
  return { ok: true, deviceSecret: await mintCredential(deps, tenantId, deviceId, userId) };
}

/** Public: device credential → fresh hub tokens. Refused once the device is disabled. */
export async function exchangeDeviceToken(
  deps: EnrollmentDeps,
  tenantId: string,
  deviceId: string,
  secret: string,
): Promise<({ ok: true } & HubTokens) | Failure> {
  const cred = await readJson<CredRecord>(deps, tenantId, credKey(deviceId)).catch(() => null);
  if (!cred || !sameHash(sha256(secret), cred.hash)) return fail(401, "DEVICE_CREDENTIAL_INVALID", "بيانات اعتماد الجهاز غير صالحة — أعد تسجيل الجهاز");
  const device = await deps.syncDeviceRepo.findById(tenantId as never, deviceId as never);
  if (!device) return fail(401, "SYNC_UNKNOWN_DEVICE", "الجهاز غير مسجّل في المركز");
  if (device.revokedAt) return fail(403, "SYNC_DEVICE_REVOKED", "الجهاز معطَّل في المركز — راجع المسؤول");
  try {
    await assertTenantLicenseAllowsAccess({ licenseRepo: deps.licenseRepo, tenantRepo: deps.tenantRepo, tenantId });
  } catch (e) {
    return fail(403, "LICENSE_BLOCKED", e instanceof Error ? e.message : "ترخيص المركز لا يسمح بالمزامنة");
  }
  const user = await activeUser(tenantId, cred.userId);
  if (!user) return fail(403, "ENROLL_ISSUER_INACTIVE", "الحساب المرتبط بالجهاز لم يعد فعّالاً — أعد تسجيل الجهاز");
  return { ok: true, ...(await issueTokens(deps, tenantId, cred.userId, user.name, user.role)) };
}
