import { z } from "zod";
import type { TenantContext, UUID } from "../../../domain/types/index.js";
import type { ILicenseProvider } from "../../../application/ports/ILicenseProvider.js";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import type { ISecretsRepository } from "../../../application/ports/ISecretsRepository.js";
import type { IMachineFingerprintProvider } from "../../../application/ports/IMachineFingerprintProvider.js";
import type { ILicenseTokenSigner } from "../../../application/ports/ILicenseTokenSigner.js";

/**
 * Phase 0 sub-batch 0E — license use cases.
 *
 * One file per the existing pattern (parties/partyUseCases.ts etc.).
 * Each use case:
 *   - Takes the port (provider / repo) as the first argument.
 *   - Returns `Result<T>` = `{ ok: true; data?: T } | { ok: false; error: string }`.
 *   - Validates inputs with zod.
 *   - Does not throw — converts errors to `ok: false` and the route
 *     layer maps them to HTTP status codes.
 */

type Result<T> = { ok: true; data?: T } | { ok: false; error: string };

/**
 * License actions that need token denylisting. The interface accepts
 * ttlMs (milliseconds) for token blacklisting. RedisTokenDenylist uses
 * ttlSeconds internally, we adapt.
 */
type TokenDenylist = {
  has: (jti: string) => Promise<boolean>;
  add: (jti: string, ttlMs: number) => Promise<void>;
};

const activateInput = z.object({
  key: z.string().min(1),
  tenantId: z.string().uuid(),
  serverFingerprint: z.string().min(1),
  hostname: z.string().optional(),
  appVersion: z.string().optional(),
});

export async function activateLicenseUseCase(
  provider: ILicenseProvider,
  secretsRepo: ISecretsRepository,
  input: unknown,
): Promise<Result<{ activationId: string; tenantId: string; features: string[]; offlineToken: string }>> {
  const parsed = activateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "بيانات التفعيل غير صالحة" };
  }
  try {
    const result = await provider.activate({
      key: parsed.data.key,
      tenantId: parsed.data.tenantId,
      serverFingerprint: parsed.data.serverFingerprint,
      serverFingerprintVersion: 1,
      hostname: parsed.data.hostname,
      appVersion: parsed.data.appVersion,
    });
    // R16: persist the signed offline token (encrypted at rest) so the
    // license-enforcement guard can verify it without a live call.
    await secretsRepo.put(parsed.data.tenantId as UUID, "license.token.current", result.offlineToken);
    // R11: persist the token id so deactivation/revoke can denylist it.
    await secretsRepo.put(parsed.data.tenantId as UUID, "license.token.jti", result.jti);
    return { ok: true, data: result };
  } catch (e) {
    const msg = "فشل التفعيل";
    return { ok: false, error: msg };
  }
}

export async function heartbeatUseCase(
  provider: ILicenseProvider,
  licenseRepo: ILicenseRepository,
  ctx: TenantContext,
  fingerprintProvider: IMachineFingerprintProvider,
): Promise<Result<{ status: string; graceRemainingDays: number }>> {
  try {
    const lic = await licenseRepo.findActiveForTenant(ctx.tenantId as UUID);
    if (!lic) return { ok: false, error: "لا توجد ترخيص نشط" };
    const activation = await licenseRepo.findActiveActivationForLicense(lic.id as UUID);
    if (!activation) return { ok: false, error: "لا يوجد تنشيط نشط" };

    // Best-effort fingerprint re-check. Mismatch logs an audit event
    // and bumps the grace clock (does not immediately lock the
    // install — gives the operator time to use the transfer flow).
    const input = await fingerprintProvider.collect();
    const hash = await fingerprintProvider.compute(input);
    if (activation.serverFingerprint !== hash) {
      await licenseRepo.logEvent({
        licenseId: lic.id as UUID,
        tenantId: ctx.tenantId as UUID,
        eventType: "hardware_changed",
        payload: { expected: activation.serverFingerprint, actual: hash },
        actor: ctx.userName,
        ipAddress: null,
        requestId: null,
      });
    }

    const result = await provider.refresh(activation.id as UUID);
    return {
      ok: true,
      data: {
        status: result.status,
        graceRemainingDays: result.graceRemainingDays,
      },
    };
  } catch (e) {
    return { ok: false, error: "فشل فحص الترخيص" };
  }
}

export async function deactivateLicenseUseCase(
  provider: ILicenseProvider,
  licenseRepo: ILicenseRepository,
  secretsRepo: ISecretsRepository,
  tokenDenylist: TokenDenylist,
  ctx: TenantContext,
  reason: string,
): Promise<Result<true>> {
  try {
    const lic = await licenseRepo.findActiveForTenant(ctx.tenantId as UUID);
    if (!lic) return { ok: false, error: "لا توجد ترخيص نشط" };
    const activation = await licenseRepo.findActiveActivationForLicense(lic.id as UUID);
    if (!activation) return { ok: false, error: "لا يوجد تنشيط نشط" };
    await provider.deactivate(activation.id as UUID, reason);
    // R11: denylist the offline token's jti so a captured/valid token is
    // rejected by the enforcement guard immediately.
    const jtiRow = await secretsRepo.get(ctx.tenantId as UUID, "license.token.jti");
    if (jtiRow) {
      await tokenDenylist.add(String(jtiRow), 30 * 24 * 60 * 60 * 1000);
    }
    return { ok: true, data: true };
  } catch (e) {
    return { ok: false, error: "فشل إلغاء التنشيط" };
  }
}

export async function listDevicesUseCase(
  provider: ILicenseProvider,
  licenseRepo: ILicenseRepository,
  ctx: TenantContext,
): Promise<Result<Awaited<ReturnType<typeof provider.listDevices>>>> {
  try {
    const lic = await licenseRepo.findActiveForTenant(ctx.tenantId as UUID);
    if (!lic) return { ok: false, error: "لا توجد ترخيص نشط" };
    const devices = await provider.listDevices(lic.id as UUID);
    return { ok: true, data: devices };
  } catch (e) {
    return { ok: false, error: "فشل جلب الأجهزة" };
  }
}

export async function revokeDeviceUseCase(
  provider: ILicenseProvider,
  licenseRepo: ILicenseRepository,
  secretsRepo: ISecretsRepository,
  tokenDenylist: TokenDenylist,
  ctx: TenantContext,
  deviceId: string,
  reason: string,
): Promise<Result<true>> {
  try {
    const lic = await licenseRepo.findActiveForTenant(ctx.tenantId as UUID);
    if (!lic) return { ok: false, error: "لا توجد ترخيص نشط" };
    const activation = await licenseRepo.findActiveActivationForLicense(lic.id as UUID);
    if (!activation) return { ok: false, error: "لا يوجد تنشيط نشط" };
    await provider.revokeDevice(activation.id as UUID, deviceId, reason);
    // R11: denylist the offline token jti on device revoke too.
    const jtiRow = await secretsRepo.get(ctx.tenantId as UUID, "license.token.jti");
    if (jtiRow) {
      await tokenDenylist.add(String(jtiRow), 30 * 24 * 60 * 60 * 1000);
    }
    return { ok: true, data: true };
  } catch (e) {
    return { ok: false, error: "فشل إلغاء الجهاز" };
  }
}

export async function getCurrentLicenseUseCase(
  licenseRepo: ILicenseRepository,
  secretsRepo: ISecretsRepository,
  ctx: TenantContext,
): Promise<Result<{ license: unknown; hasOfflineToken: boolean }>> {
  try {
    const lic = await licenseRepo.findActiveForTenant(ctx.tenantId as UUID);
    if (!lic) return { ok: false, error: "لا توجد ترخيص نشط" };
    const tokenRow = await secretsRepo.get(ctx.tenantId as UUID, "license.token.current");
    return { ok: true, data: { license: lic, hasOfflineToken: !!tokenRow } };
  } catch (e) {
    return { ok: false, error: "فشل جلب الترخيص" };
  }
}

export async function verifyOfflineTokenUseCase(
  signer: ILicenseTokenSigner,
  token: string,
): Promise<Result<{ tenantId: string; licenseId: string; features: string[] }>> {
  try {
    const v = await signer.verify(token);
    return {
      ok: true,
      data: {
        tenantId: v.payload.tenantId,
        licenseId: v.payload.licenseId,
        features: v.payload.features,
      },
    };
  } catch (e) {
    return { ok: false, error: "فشل التحقق من التوكن" };
  }
}