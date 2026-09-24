import { z } from "zod";
import type { ITenantRepository } from "../../../application/ports/ITenantRepository.js";
import type {
  IInstallationStateRepository,
  WizardStepName,
} from "../../../application/ports/IInstallationStateRepository.js";
import type { ILicenseProvider } from "../../../application/ports/ILicenseProvider.js";
import type { IMachineFingerprintProvider } from "../../../application/ports/IMachineFingerprintProvider.js";
import type { ISecretsRepository } from "../../../application/ports/ISecretsRepository.js";
import type { ICompanyRepository } from "../../../application/ports/ICompanyRepository.js";
import type { IAuthRepository } from "../../../application/ports/IAuthRepository.js";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import type { IPasswordHasher } from "../../../application/ports/IPasswordHasher.js";
import type { ILicenseTokenSigner } from "../../../application/ports/ILicenseTokenSigner.js";
import type { IInstallationIdStorage } from "../../../application/ports/IInstallationIdStorage.js";
import { config } from "../../../infrastructure/config/env.js";
import { runWithTenantContext } from "../../../infrastructure/orm/tenant-context.js";
import { resolveDeviceLimit } from "../../../domain/licensing/ownership.js";
import { composeDeviceFingerprint } from "../../../domain/licensing/installationIdentity.js";
import { ensureServerInstallation } from "../../../infrastructure/installation/ensureServerInstallation.js";
import { db as defaultDb } from "../../../infrastructure/orm/drizzle.js";
import { randomUUID } from "node:crypto";
import { recordDesktopDeviceActivation } from "./recordDesktopDeviceActivation.js";
import { MultipleTenantsDetectedError } from "../../../domain/errors/index.js";
import { isWeakPin } from "../../../domain/value-objects/pinStrength.js";

/**
 * Phase 0 sub-batches 0F + 0G — setup use cases.
 *
 * - `startWizardUseCase`: bootstraps a brand-new install. Creates the
 *   tenant, persists the wizard state, returns the bootstrap state.
 * - `getStatusUseCase`: read-only — used by the InstallGate to decide
 *   whether to redirect the user to /setup/*.
 * - `activateAndPersistUseCase`: after the user enters an activation
 *   key, calls the license provider, persists the signed offline
 *   token in `secrets`, updates the denormalized tenant cache, and
 *   advances the wizard.
 * - `saveStepUseCase`: persists a wizard step (company info, admin
 *   credentials, etc.) and advances the cursor.
 * - `completeWizardUseCase`: creates the first Owner user, marks the
 *   wizard complete, and returns the signed-in user record.
 *
 * Pattern follows the existing use-cases (e.g. partyUseCases.ts):
 * returns a `Result<T>` discriminated union.
 */
type Result<T> = { ok: true; data?: T } | { ok: false; error: string; code?: string };

// Fix C-3 (forensic audit 2026-08-15): none of the wizard-mutating use
// cases below ever checked whether the target tenant's wizard was already
// completed. The SETUP_TOKEN gate only answers "is this caller an
// operator" — it says nothing about "is this specific tenant still
// provisionable". Live reproduction against a real Postgres instance
// confirmed the full chain: a second, unauthenticated call to
// wizard/admin with a completed tenant's id overwrote the pending admin
// payload, and wizard/complete then created a brand-new `admin` user
// under that tenant for whoever called it last — a full account
// takeover with no token and no credentials, reachable even when
// SETUP_TOKEN is configured correctly, because the token never varies
// per tenant. Once `isCompleted` is true for a tenant, every mutating
// step must refuse outright, regardless of the token.
async function tenantAlreadyProvisioned(
  installationStateRepo: IInstallationStateRepository,
  authRepo: IAuthRepository,
  tenantId: string,
): Promise<boolean> {
  const state = await installationStateRepo.findByTenant(tenantId);
  if (state?.isCompleted) return true;
  const users = await authRepo.listActiveUsersForTenant(tenantId);
  return users.length > 0;
}

async function resolveActivationTenantId(
  deps: { licenseRepo: ILicenseRepository; tenantRepo: ITenantRepository },
  postedTenantId: string,
  licenseKey: string | undefined,
): Promise<string> {
  if (licenseKey) {
    const lic = await deps.licenseRepo.findByKey(licenseKey);
    if (lic?.tenantId) return lic.tenantId;
  }
  const defaultTenant = await deps.tenantRepo.findBySlug("default");
  if (defaultTenant) return defaultTenant.id;
  return postedTenantId;
}

async function assertWizardMutable(
  installationStateRepo: IInstallationStateRepository,
  tenantId: string,
): Promise<{ ok: true } | { ok: false; error: string; code: "ALREADY_COMPLETED" }> {
  const state = await installationStateRepo.findByTenant(tenantId as never);
  if (state?.isCompleted) {
    return {
      ok: false,
      error: "تم إكمال إعداد هذا الحساب مسبقاً — لا يمكن تعديله عبر معالج الإعداد",
      code: "ALREADY_COMPLETED",
    };
  }
  return { ok: true };
}

const startInput = z.object({
  companyName: z.string().min(1).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/i)
    .optional(),
});

export async function startWizardUseCase(
  tenantRepo: ITenantRepository,
  installationStateRepo: IInstallationStateRepository,
  input: unknown,
): Promise<Result<{ tenantId: string; isCompleted: boolean }>> {
  const parsed = startInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "بيانات غير صالحة" };

  try {
    // Desktop SKU: the installer DB already has the seeded tenant + baked
    // license (slug `default`). Creating a second tenant here would make
    // activate look up the license on the wrong id and fail.
    if (config.DESKTOP_DEPLOY) {
      const existing = await tenantRepo.findBySlug("default");
      if (existing) {
        const state =
          (await installationStateRepo.findByTenant(existing.id)) ??
          (await installationStateRepo.create(existing.id, {
            bootstrapAt: new Date().toISOString(),
          }));
        return {
          ok: true,
          data: { tenantId: existing.id, isCompleted: state.isCompleted },
        };
      }
    }

    // Web / server: reuse pre-provisioned tenant when the DB was seeded
    // (slug `default`) or a prior install already completed the wizard.
    const defaultTenant = await tenantRepo.findBySlug("default");
    if (defaultTenant) {
      const state =
        (await installationStateRepo.findByTenant(defaultTenant.id)) ??
        (await installationStateRepo.create(defaultTenant.id, {
          bootstrapAt: new Date().toISOString(),
        }));
      return {
        ok: true,
        data: { tenantId: defaultTenant.id, isCompleted: state.isCompleted },
      };
    }

    const completedTenantId = await installationStateRepo.findAnyCompleted();
    if (completedTenantId) {
      return {
        ok: true,
        data: { tenantId: completedTenantId, isCompleted: true },
      };
    }

    const companyName = parsed.data.companyName ?? "شركة جديدة";
    const slug = parsed.data.slug ?? `tenant-${Math.random().toString(36).slice(2, 10)}`;
    const existing = await tenantRepo.findBySlug(slug);
    if (existing) {
      const state = await installationStateRepo.findByTenant(existing.id);
      return {
        ok: true,
        data: { tenantId: existing.id, isCompleted: state?.isCompleted ?? false },
      };
    }
    const tenant = await tenantRepo.create({
      name: companyName,
      slug,
    });
    const state = await installationStateRepo.create(tenant.id, {
      bootstrapAt: new Date().toISOString(),
    });
    return { ok: true, data: { tenantId: state.tenantId, isCompleted: state.isCompleted } };
  } catch (e) {
    if (e instanceof MultipleTenantsDetectedError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: "فشل بدء المعالج" };
  }
}

export async function getStatusUseCase(
  installationStateRepo: IInstallationStateRepository,
  tenantId: string,
): Promise<Result<{ isCompleted: boolean; currentStep: string }>> {
  const state = await installationStateRepo.findByTenant(tenantId);
  if (!state) return { ok: true, data: { isCompleted: false, currentStep: "welcome" } };
  return {
    ok: true,
    data: { isCompleted: state.isCompleted, currentStep: state.currentStep },
  };
}

const activateInput = z.object({
  // Empty key is valid in DESKTOP_DEPLOY (pre-baked license, no customer key).
  key: z.string().optional(),
  hostname: z.string().optional(),
  appVersion: z.string().optional(),
  platform: z.enum(["windows", "macos", "linux", "android", "ios", "web"]).optional(),
  /** Browser/device fingerprint from the activating client (web PIN roster). */
  clientFingerprint: z.string().min(16).max(128).optional(),
});

/**
 * L-3 (option d) — desktop verify-only license bootstrap.
 *
 * In DESKTOP_DEPLOY the offline token is baked into `licenses.offline_token`
 * at BUILD TIME (dev machine, with the private key) and shipped inside the
 * installer DB. This use-case promotes that baked token into the encrypted
 * `secrets` store on first launch (after APP_MASTER_KEY is available), which
 * is what the runtime license guard actually reads. It is idempotent and
 * pure-verify: it NEVER signs anything (no private key at runtime).
 */
export async function bootstrapDesktopLicenseUseCase(
  deps: {
    licenseRepo: ILicenseRepository;
    secretsRepo: ISecretsRepository;
    tokenSigner: ILicenseTokenSigner;
  },
  tenantId: string,
): Promise<Result<{ migrated: boolean }>> {
  if (!config.DESKTOP_DEPLOY) return { ok: true, data: { migrated: false } };

  // Pre-JWT bootstrap flow: no ALS context exists yet, so stamp the tenant
  // GUC from the explicit tenantId (RLS category-2 licenses: own-tenant rows).
  const baked = await runWithTenantContext({ tenantId }, () =>
    deps.licenseRepo.findBakedForTenant(tenantId as never),
  );
  if (!baked || !baked.offlineToken) {
    // Nothing baked for this tenant — the wizard/activation flow will surface
    // the appropriate (unlicensed) state. No error.
    return { ok: true, data: { migrated: false } };
  }

  // Verify the baked token is genuine (signed by our public key) before
  // promoting it. A tampered/forgeable token fails here and is never stored.
  try {
    await deps.tokenSigner.verify(baked.offlineToken);
  } catch {
    return { ok: false, error: "الرمز المخبوز غير صالح أو مُعطَّب", code: "BAD_BAKED_TOKEN" };
  }

  // Idempotent: skip if already migrated.
  const existing = await deps.secretsRepo.get(tenantId, "license.token.current");
  if (existing) return { ok: true, data: { migrated: false } };

  await deps.secretsRepo.put(tenantId, "license.token.current", baked.offlineToken);
  if (baked.offlineTokenJti) {
    await deps.secretsRepo.put(tenantId, "license.token.jti", baked.offlineTokenJti);
  }
  return { ok: true, data: { migrated: true } };
}

export async function activateAndPersistUseCase(
  deps: {
    licenseProvider: ILicenseProvider;
    tenantRepo: ITenantRepository;
    installationStateRepo: IInstallationStateRepository;
    secretsRepo: ISecretsRepository;
    fingerprintProvider: IMachineFingerprintProvider;
    installationIdStorage: IInstallationIdStorage;
    tokenSigner: ILicenseTokenSigner;
    licenseRepo: ILicenseRepository;
    authRepo: IAuthRepository;
  },
  tenantId: string,
  input: unknown,
): Promise<
  Result<{
    activationId: string;
    features: string[];
    expiresAt: string | null;
    tenantId?: string;
    isCompleted?: boolean;
    /**
     * Section 3, Step 2 — the company name shown as "Welcome, <Company>".
     * It comes from the license the vendor issued (customer_name, or the
     * vendor metadata's company_name). The end user never types it, so it is
     * surfaced from the license record rather than from wizard input.
     */
    companyName?: string | null;
  }>
> {
  const parsed = activateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "بيانات التفعيل غير صالحة" };
  if (!config.DESKTOP_DEPLOY && !(parsed.data.key && parsed.data.key.length >= 1)) {
    return { ok: false, error: "بيانات التفعيل غير صالحة" };
  }
  try {
    const fingerprint = await deps.fingerprintProvider.collect();
    const metadata = await deps.fingerprintProvider.getMetadata(fingerprint);
    const installationId = await deps.installationIdStorage.readOrCreate();
    // Canonical Installation fingerprint: hostHash::installationId
    // Web clients also send a browser fingerprint — prefer that for the seat.
    const hostCombined = composeDeviceFingerprint(metadata.hash, installationId);
    const combined = parsed.data.clientFingerprint
      ? composeDeviceFingerprint(parsed.data.clientFingerprint, installationId)
      : hostCombined;

    // ── D3 / option d: DESKTOP_DEPLOY is verify-only ──
    // The token is pre-baked (signed off-device). We promote it into the
    // encrypted secrets store (idempotent) and treat the license as
    // activated — NO signing, NO call to the license provider/server.
    if (config.DESKTOP_DEPLOY) {
      let effectiveTenantId = tenantId;
      let lic = await runWithTenantContext({ tenantId: effectiveTenantId }, () =>
        deps.licenseRepo.findBakedForTenant(effectiveTenantId as never),
      );
      if (!lic) {
        const fallback = await deps.tenantRepo.findBySlug("default");
        if (fallback) {
          effectiveTenantId = fallback.id;
          lic = await runWithTenantContext({ tenantId: effectiveTenantId }, () =>
            deps.licenseRepo.findBakedForTenant(effectiveTenantId as never),
          );
        }
      }

      const boot = await bootstrapDesktopLicenseUseCase(
        {
          licenseRepo: deps.licenseRepo,
          secretsRepo: deps.secretsRepo,
          tokenSigner: deps.tokenSigner,
        },
        effectiveTenantId,
      );
      if (!boot.ok) {
        return { ok: false, error: boot.error ?? "فشل تفعيل الترخيص", code: boot.code };
      }

      if (!lic) return { ok: false, error: "فشل تفعيل الترخيص (لا يوجد ترخيص مخبوز)" };

      let activationId: string;
      try {
        const recorded = await recordDesktopDeviceActivation({
          licenseId: lic.id,
          tenantId: effectiveTenantId,
          serverFingerprint: combined,
          serverFingerprintVersion: metadata.version,
          hostname: parsed.data.hostname,
          platform: parsed.data.platform,
          appVersion: parsed.data.appVersion,
          maxDevices: resolveDeviceLimit({
            limits: lic.limits as { devices?: number } | null,
            maxDevices: lic.maxDevices,
          }),
        });
        activationId = recorded.activationId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "DEVICE_LIMIT_REACHED") {
          return {
            ok: false,
            error: "تم بلوغ الحد الأقصى للأجهزة على هذا الترخيص",
            code: "DEVICE_LIMIT_REACHED",
          };
        }
        throw e;
      }

      await deps.tenantRepo.setLicenseCache(effectiveTenantId, {
        licenseStatus: lic.status ?? "active",
        licenseType: lic.type ?? "full",
        maxDevices: resolveDeviceLimit({
          limits: lic.limits as { devices?: number } | null,
          maxDevices: lic.maxDevices,
        }),
        activationId,
        serverFingerprint: combined,
        licenseKey: parsed.data.key || lic.key,
        licenseExpiresAt: lic.expiresAt ?? null,
        lastHeartbeatAt: new Date(),
      });

      await deps.installationStateRepo.saveStep(effectiveTenantId, "activate", {
        key: parsed.data.key,
        activationId,
      });

      // Desktop template ships tenant + baked license only (0 users). Mark
      // complete only when an owner already exists (upgrade / re-activate);
      // otherwise the onboarding wizard must collect name + PIN.
      let isCompleted = false;
      if (
        await tenantAlreadyProvisioned(
          deps.installationStateRepo,
          deps.authRepo,
          effectiveTenantId,
        )
      ) {
        const completed = await deps.installationStateRepo.markCompleted(
          effectiveTenantId as never,
        );
        isCompleted = completed.isCompleted;
      }

      await ensureServerInstallation(defaultDb, {
        installationId,
        tenantId: effectiveTenantId,
        hostname: parsed.data.hostname ?? null,
        appVersion: parsed.data.appVersion ?? null,
      });

      const companyName =
        (lic.customerName && String(lic.customerName).trim()) ||
        (lic.vendorMetadata &&
        typeof lic.vendorMetadata === "object" &&
        lic.vendorMetadata !== null &&
        "companyName" in lic.vendorMetadata &&
        typeof (lic.vendorMetadata as { companyName?: unknown }).companyName === "string"
          ? String((lic.vendorMetadata as { companyName: string }).companyName).trim()
          : "") ||
        undefined;

      return {
        ok: true,
        data: {
          activationId,
          features: lic.features ?? [],
          expiresAt: lic.expiresAt?.toISOString() ?? null,
          tenantId: effectiveTenantId,
          isCompleted,
          companyName,
        },
      };
    }

    const effectiveTenantId = await resolveActivationTenantId(
      deps,
      tenantId,
      parsed.data.key,
    );

    const result = await deps.licenseProvider.activate({
      key: parsed.data.key ?? "",
      serverFingerprint: combined,
      serverFingerprintVersion: metadata.version,
      hostname: parsed.data.hostname,
      appVersion: parsed.data.appVersion,
      platform: parsed.data.platform,
      tenantId: effectiveTenantId,
    });

    // Persist the signed offline token in `secrets` (encrypted at
    // rest by the cipher injected into the repo). R11: also persist its jti
    // so deactivation/revoke can denylist it.
    await deps.secretsRepo.put(effectiveTenantId, "license.token.current", result.offlineToken);
    await deps.secretsRepo.put(effectiveTenantId, "license.token.jti", result.jti);

    // Update the tenant's denormalized cache with the REAL license values
    // (R7): the provider already wrote correct columns during activate(),
    // but we re-assert them here so the cache always reflects the source
    // of truth and never a hardcoded default.
    // Re-assert the cache from the source of truth — the tenant-stamped read
    // (RLS category-2: own-tenant license row) in the same bootstrap flow.
    const lic = await runWithTenantContext({ tenantId: effectiveTenantId }, () =>
      deps.licenseRepo.findById(result.licenseId as never),
    );
    await deps.tenantRepo.setLicenseCache(effectiveTenantId, {
      licenseStatus: lic?.status ?? "active",
      licenseType: lic?.type ?? "full",
      maxDevices: resolveDeviceLimit({
        limits: lic?.limits as { devices?: number } | null,
        maxDevices: lic?.maxDevices,
      }),
      activationId: result.activationId,
      serverFingerprint: combined,
      licenseKey: lic?.key ?? parsed.data.key,
      licenseExpiresAt: lic?.expiresAt ?? null,
      lastHeartbeatAt: new Date(),
    });

    // Advance the wizard.
    await deps.installationStateRepo.saveStep(effectiveTenantId, "activate", {
      key: parsed.data.key,
      activationId: result.activationId,
    });

    await ensureServerInstallation(defaultDb, {
      installationId,
      tenantId: effectiveTenantId,
      hostname: parsed.data.hostname ?? null,
      appVersion: parsed.data.appVersion ?? null,
    });

    // Pre-provisioned installs (seeded admin/company): skip company/admin wizard
    // after the one-time license activation, same as desktop pre-baked SKU.
    let isCompleted = false;
    if (
      await tenantAlreadyProvisioned(
        deps.installationStateRepo,
        deps.authRepo,
        effectiveTenantId,
      )
    ) {
      const completed = await deps.installationStateRepo.markCompleted(
        effectiveTenantId as never,
      );
      isCompleted = completed.isCompleted;
    }

    return {
      ok: true,
      data: {
        activationId: result.activationId,
        features: result.features,
        expiresAt: result.expiresAt?.toISOString() ?? null,
        tenantId: effectiveTenantId,
        isCompleted,
        companyName:
          (lic?.customerName && String(lic.customerName).trim()) ||
          (lic?.vendorMetadata &&
          typeof lic.vendorMetadata === "object" &&
          lic.vendorMetadata !== null &&
          "companyName" in lic.vendorMetadata &&
          typeof (lic.vendorMetadata as { companyName?: unknown }).companyName === "string"
            ? String((lic.vendorMetadata as { companyName: string }).companyName).trim()
            : "") ||
          null,
      },
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e ?? "");
    if (raw === "INVALID_LICENSE") {
      return { ok: false, error: "مفتاح الترخيص غير صالح أو غير موجود", code: "INVALID_LICENSE" };
    }
    if (raw === "DEVICE_LIMIT_REACHED") {
      return {
        ok: false,
        error: "تم بلوغ الحد الأقصى للأجهزة على هذا الترخيص",
        code: "DEVICE_LIMIT_REACHED",
      };
    }
    if (raw === "ALREADY_ACTIVE") {
      return { ok: false, error: "الترخيص مفعّل حالياً على جهاز آخر", code: "ALREADY_ACTIVE" };
    }
    if (raw.startsWith("LICENSE_")) {
      return { ok: false, error: "الترخيص غير صالح للاستخدام", code: raw };
    }
    // Avoid leaking raw SQL / driver noise to the client; keep known codes above.
    return { ok: false, error: "فشل التفعيل", code: "ACTIVATION_FAILED" };
  }
}

export function generateRequestId(): string {
  return randomUUID();
}

// ── 0G: wizard steps ────────────────────────────────────────────

const companyStepInput = z.object({
  name: z.string().min(1),
  commercialReg: z.string().optional(),
  taxNumber: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  currency: z.string().length(3).optional(),
  language: z.string().min(2).max(5).optional(),
  fiscalYearStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  defaultTaxRate: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .optional(),
});

export async function saveCompanyStepUseCase(
  companyRepo: ICompanyRepository,
  installationStateRepo: IInstallationStateRepository,
  tenantId: string,
  input: unknown,
): Promise<Result<true>> {
  const parsed = companyStepInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "بيانات الشركة غير صالحة" };
  const guard = await assertWizardMutable(installationStateRepo, tenantId);
  if (!guard.ok) return guard;
  try {
    await companyRepo.upsert({
      tenantId: tenantId as never,
      ...parsed.data,
    });
    await installationStateRepo.saveStep(tenantId as never, "company", parsed.data);
    return { ok: true, data: true };
  } catch (e) {
    return { ok: false, error: "فشل حفظ بيانات الشركة" };
  }
}

const adminStepInput = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
    pin: z.string().regex(/^\d{4}$/).optional(),
  })
  .refine((d) => Boolean(d.password || d.pin), {
    message: "password_or_pin_required",
  });

export async function saveAdminStepUseCase(
  deps: {
    installationStateRepo: IInstallationStateRepository;
    passwordHasher: IPasswordHasher;
  },
  tenantId: string,
  input: unknown,
): Promise<Result<true>> {
  const parsed = adminStepInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "بيانات المسؤول غير صالحة" };
  if (parsed.data.pin && isWeakPin(parsed.data.pin)) {
    return {
      ok: false,
      error: "هذا الرقم السري ضعيف جداً (مثل 0000 أو 1234) — يرجى اختيار رقم أصعب تخمينه",
    };
  }
  const guard = await assertWizardMutable(deps.installationStateRepo, tenantId);
  if (!guard.ok) return guard;
  try {
    const email = (parsed.data.email?.trim() || "admin@erp.local").toLowerCase();
    // Desktop onboarding may send only a 4-digit PIN; web still sends password.
    // PIN login uses pinHash; passwordHash must still exist on the user row.
    const passwordHash = await deps.passwordHasher.hash(
      parsed.data.password ?? parsed.data.pin!,
    );
    const pinHash = parsed.data.pin
      ? await deps.passwordHasher.hash(parsed.data.pin)
      : undefined;
    await deps.installationStateRepo.saveStep(tenantId as never, "admin", {
      name: parsed.data.name,
      email,
      // The hash is held in the wizard state until completeWizard
      // promotes it to a real `users` row. Hashes must never be
      // echoed back to the client.
      passwordHash,
      ...(pinHash ? { pinHash } : {}),
    });
    return { ok: true, data: true };
  } catch (e) {
    return { ok: false, error: "فشل حفظ بيانات المسؤول" };
  }
}

const reviewInput = z.object({ confirmed: z.literal(true) });

export async function saveReviewStepUseCase(
  installationStateRepo: IInstallationStateRepository,
  tenantId: string,
  input: unknown,
): Promise<Result<true>> {
  const parsed = reviewInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "يجب تأكيد المراجعة" };
  const guard = await assertWizardMutable(installationStateRepo, tenantId);
  if (!guard.ok) return guard;
  await installationStateRepo.saveStep(tenantId as never, "review", { confirmed: true });
  return { ok: true, data: true };
}

export async function completeWizardUseCase(
  deps: {
    installationStateRepo: IInstallationStateRepository;
    authRepo: IAuthRepository;
  },
  tenantId: string,
): Promise<Result<{ isCompleted: boolean }>> {
  try {
    const state = await deps.installationStateRepo.findByTenant(tenantId);
    if (!state) return { ok: true, data: { isCompleted: false } };
    if (state.isCompleted) {
      // Fix C-3: complete() must not re-promote whatever admin payload is
      // currently sitting in `state.data` once a tenant is already
      // provisioned — that payload can belong to a later, unauthenticated
      // caller who overwrote the original admin step (see
      // assertWizardMutable above). Re-running complete on a completed
      // tenant is a no-op that reports the existing state, never a fresh
      // user creation.
      return { ok: true, data: { isCompleted: true } };
    }

    // R1 + R20: promote the admin credentials captured during the `admin`
    // wizard step into a real Owner user. The merged wizard `data` now
    // survives later steps (R14). Use the existing `admin` role (there is
    // no separate "Owner" role in the domain) so rbac authorizes the user.
    const admin = (state.data ?? {}) as Record<string, unknown>;
    const name = String(admin.name ?? "").trim();
    const email = String(admin.email ?? "").trim();
    const passwordHash = String(admin.passwordHash ?? "");
    const pinHashRaw = admin.pinHash;
    const pinHash = typeof pinHashRaw === "string" && pinHashRaw ? pinHashRaw : undefined;
    if (!name || !email || !passwordHash) {
      return {
        ok: false,
        error: "يجب تعيين اسم المالك والرمز السري قبل إكمال الإعداد",
        code: "ADMIN_REQUIRED",
      };
    }
    const existing = await deps.authRepo.findUserByEmail(email, tenantId as never);
    if (!existing) {
      await deps.authRepo.createUser({
        tenantId: tenantId as never,
        name,
        email,
        passwordHash,
        role: "admin",
        pinHash: pinHash ?? null,
      });
    }

    const updated = await deps.installationStateRepo.markCompleted(tenantId as never);
    return { ok: true, data: { isCompleted: updated.isCompleted } };
  } catch (e) {
    return { ok: false, error: "فشل إكمال المعالج" };
  }
}

export type { WizardStepName };
