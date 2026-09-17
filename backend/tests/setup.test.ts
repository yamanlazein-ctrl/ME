import { describe, it, expect } from "vitest";
import {
  startWizardUseCase,
  getStatusUseCase,
  activateAndPersistUseCase,
} from "@/application/use-cases/setup/setupUseCases";
import { MultipleTenantsDetectedError } from "@/domain/errors/index";

/**
 * Phase 0 sub-batch 0F — setup use cases.
 *
 * Tests the input-validation contract without a live database.
 * Integration tests that exercise the full path (tenant create +
 * license activation + token persistence) are deferred to the
 * Playwright E2E suite in sub-batch 0K because they need a running
 * Postgres instance.
 */
describe("setup use cases — input validation", () => {
  it("startWizard rejects empty input", async () => {
    const r = await startWizardUseCase({} as never, {} as never, {});
    expect(r.ok).toBe(false);
  });

  it("startWizard rejects invalid slug", async () => {
    const r = await startWizardUseCase({} as never, {} as never, {
      companyName: "Acme",
      slug: "BAD SLUG WITH SPACES",
    });
    expect(r.ok).toBe(false);
  });

  it("startWizard accepts a valid input shape", async () => {
    // Will fail at the repo call (mocks are empty) — we only verify
    // that validation passes and the error message is NOT a
    // validation error.
    const r = await startWizardUseCase({} as never, {} as never, {
      companyName: "Acme",
      slug: "acme",
    });
    // Either succeeds (ok: true) or fails with a non-validation
    // error (e.g. "Cannot read property of undefined" from the mock).
    // What we DO assert: the failure is NOT a validation failure.
    if (!r.ok) {
      expect(r.error).not.toMatch(/بيانات غير صالحة/);
    }
  });

  it("getStatus returns a sensible default for an unknown tenant", async () => {
    const r = await getStatusUseCase({ findByTenant: async () => null } as never, "x");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.isCompleted).toBe(false);
      expect(r.data?.currentStep).toBe("welcome");
    }
  });

  it("activateAndPersist rejects empty key", async () => {
    const r = await activateAndPersistUseCase({} as never, "tenant", {});
    expect(r.ok).toBe(false);
  });

  it("activateAndPersist rejects a blank key outside desktop deploy", async () => {
    const r = await activateAndPersistUseCase({} as never, "tenant", { key: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/بيانات التفعيل غير صالحة/);
  });
});

/**
 * Regression test for F01 (Phase 1 foundation audit, forensic finding):
 * a new license/install must never silently bind to a different,
 * pre-existing company's tenant. StoneERP is single-tenant-per-install
 * (docs/decisions.md), so finding more than one completed tenant means
 * that invariant has already been violated and must fail loudly instead
 * of `findAnyCompleted()` picking one arbitrarily.
 *
 * This test would FAIL before the fix: the old `findAnyCompleted()`
 * silently returned whichever of the two completed tenants sorted first,
 * and `startWizardUseCase` happily handed that stranger's tenantId back
 * as `{ ok: true, isCompleted: true }`.
 */
describe("startWizardUseCase — single-tenant-per-install invariant (F01)", () => {
  it("fails loudly instead of reusing an arbitrary tenant when two completed tenants exist", async () => {
    const tenantRepo = {
      findBySlug: async () => null, // no pre-seeded "default" tenant
    };
    const installationStateRepo = {
      findAnyCompleted: async () => {
        // Simulates the repository-layer guard: >1 completed tenant found.
        throw new MultipleTenantsDetectedError();
      },
    };

    const r = await startWizardUseCase(tenantRepo as never, installationStateRepo as never, {
      companyName: "New Customer Co",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MULTIPLE_TENANTS_DETECTED");
    }
  });

  it("still returns the sole completed tenant when exactly one exists (no false positives)", async () => {
    const EXISTING_TENANT_ID = "11111111-1111-1111-1111-111111111111";
    const tenantRepo = {
      findBySlug: async () => null,
    };
    const installationStateRepo = {
      findAnyCompleted: async () => EXISTING_TENANT_ID,
    };

    const r = await startWizardUseCase(tenantRepo as never, installationStateRepo as never, {
      companyName: "Acme",
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.tenantId).toBe(EXISTING_TENANT_ID);
      expect(r.data?.isCompleted).toBe(true);
    }
  });
});

/**
 * Regression test for the SETUP_STATUS_UNAVAILABLE 503 on a genuinely
 * fresh install (Phase 1 audit, Cluster A). The route no longer falls
 * back to the literal string "bootstrap" (not a valid uuid) when no
 * BOOTSTRAP_TENANT_ID and no completed tenant exist yet — it must report
 * `{ isCompleted: false }` directly. That routing behavior is exercised
 * end-to-end in the route/integration suite; here we lock in that
 * `getStatusUseCase` itself (the piece the route falls back to) never
 * needs to be called with a non-uuid placeholder to produce a sane
 * "not completed" result for an unknown tenant.
 */
describe("getStatusUseCase — fresh install", () => {
  it("reports not-completed for a tenant with no wizard-state row, without throwing", async () => {
    const r = await getStatusUseCase({ findByTenant: async () => null } as never, "any-id");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.isCompleted).toBe(false);
      expect(r.data?.currentStep).toBe("welcome");
    }
  });
});
