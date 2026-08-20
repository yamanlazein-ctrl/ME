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
import { randomUUID } from "node:crypto";

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
  key: z.string().min(1),
  hostname: z.string().optional(),
  appVersion: z.string().optional(),
});

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
  },
  tenantId: string,
  input: unknown,
): Promise<Result<{ activationId: string; features: string[]; expiresAt: string | null }>> {
  const parsed = activateInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "بيانات التفعيل غير صالحة" };
  try {
    const fingerprint = await deps.fingerprintProvider.collect();
    const metadata = await deps.fingerprintProvider.getMetadata(fingerprint);
    const installationId = await deps.installationIdStorage.readOrCreate();
    // Combine the host fingerprint with the installation id so a
    // re-imaged host with the same MAC still triggers a re-activation.
    const combined = `${metadata.hash}::${installationId}`;

    const result = await deps.licenseProvider.activate({
      key: parsed.data.key,
      serverFingerprint: combined,
      serverFingerprintVersion: metadata.version,
      hostname: parsed.data.hostname,
      appVersion: parsed.data.appVersion,
      tenantId,
    });

    // Persist the signed offline token in `secrets` (encrypted at
    // rest by the cipher injected into the repo). R11: also persist its jti
    // so deactivation/revoke can denylist it.
    await deps.secretsRepo.put(tenantId, "license.token.current", result.offlineToken);
    await deps.secretsRepo.put(tenantId, "license.token.jti", result.jti);

    // Update the tenant's denormalized cache with the REAL license values
    // (R7): the provider already wrote correct columns during activate(),
    // but we re-assert them here so the cache always reflects the source
    // of truth and never a hardcoded default.
    const lic = await deps.licenseRepo.findById(result.licenseId as never);
    await deps.tenantRepo.setLicenseCache(tenantId, {
      licenseStatus: lic?.status ?? "active",
      licenseType: lic?.type ?? "full",
      maxDevices: lic?.maxDevices ?? 3,
      activationId: result.activationId,
      serverFingerprint: combined,
      licenseKey: lic?.key ?? parsed.data.key,
      licenseExpiresAt: lic?.expiresAt ?? null,
      lastHeartbeatAt: new Date(),
    });

    // Advance the wizard.
    await deps.installationStateRepo.saveStep(tenantId, "activate", {
      key: parsed.data.key,
      activationId: result.activationId,
    });

    return {
      ok: true,
      data: {
        activationId: result.activationId,
        features: result.features,
        expiresAt: result.expiresAt?.toISOString() ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: "فشل التفعيل" };
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

const adminStepInput = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
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
  const guard = await assertWizardMutable(deps.installationStateRepo, tenantId);
  if (!guard.ok) return guard;
  try {
    const passwordHash = await deps.passwordHasher.hash(parsed.data.password);
    await deps.installationStateRepo.saveStep(tenantId as never, "admin", {
      name: parsed.data.name,
      email: parsed.data.email,
      // The hash is held in the wizard state until completeWizard
      // promotes it to a real `users` row. Hashes must never be
      // echoed back to the client.
      passwordHash,
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
    if (name && email && passwordHash) {
      const existing = await deps.authRepo.findUserByEmail(email, tenantId as never);
      if (!existing) {
        await deps.authRepo.createUser({
          tenantId: tenantId as never,
          name,
          email,
          passwordHash,
          role: "admin",
        });
      }
    }

    const updated = await deps.installationStateRepo.markCompleted(tenantId as never);
    return { ok: true, data: { isCompleted: updated.isCompleted } };
  } catch (e) {
    return { ok: false, error: "فشل إكمال المعالج" };
  }
}

export type { WizardStepName };
