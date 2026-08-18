import { describe, it, expect } from "vitest";
import { startWizardUseCase, getStatusUseCase, activateAndPersistUseCase } from "@/application/use-cases/setup/setupUseCases";

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
    const r = await startWizardUseCase(
      {} as never,
      {} as never,
      {},
    );
    expect(r.ok).toBe(false);
  });

  it("startWizard rejects invalid slug", async () => {
    const r = await startWizardUseCase(
      {} as never,
      {} as never,
      { companyName: "Acme", slug: "BAD SLUG WITH SPACES" },
    );
    expect(r.ok).toBe(false);
  });

  it("startWizard accepts a valid input shape", async () => {
    // Will fail at the repo call (mocks are empty) — we only verify
    // that validation passes and the error message is NOT a
    // validation error.
    const r = await startWizardUseCase(
      {} as never,
      {} as never,
      { companyName: "Acme", slug: "acme" },
    );
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
});
