/**
 * DESK-005: an explicit key reset (shell recovery) leaves `license.token.current` encrypted with the
 * previous APP_MASTER_KEY. Every start repairs it from the signed baked token, and never promotes a
 * licence that activation has not promoted yet.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const saved = process.env.DESKTOP_DEPLOY;
let bootstrap: typeof import("@/application/use-cases/setup/setupUseCases.js").bootstrapDesktopLicenseUseCase;

beforeAll(async () => {
  process.env.DESKTOP_DEPLOY = "true";
  vi.resetModules();
  ({ bootstrapDesktopLicenseUseCase: bootstrap } =
    await import("@/application/use-cases/setup/setupUseCases.js"));
});
afterAll(() => {
  if (saved === undefined) delete process.env.DESKTOP_DEPLOY;
  else process.env.DESKTOP_DEPLOY = saved;
});

const TENANT = "00000000-0000-4000-8000-000000000001";
const row = (ciphertext: string) => ({
  id: "s",
  tenantId: TENANT,
  key: "license.token.current",
  ciphertext,
  iv: "iv",
  authTag: "t",
  algorithm: "aes-256-gcm",
  version: 1,
  rotatedAt: null,
  createdAt: new Date(),
});

function deps(stored: ReturnType<typeof row> | null) {
  const put = vi.fn(async () => undefined);
  return {
    put,
    deps: {
      licenseRepo: {
        findBakedForTenant: async () => ({
          offlineToken: "signed.baked.token",
          offlineTokenJti: "j",
        }),
      } as never,
      secretsRepo: {
        get: async (_t: string, key: string) => (key === "license.token.current" ? stored : null),
        put,
      } as never,
      tokenSigner: { verify: async () => ({ payload: {}, exp: 0 }) } as never,
      // The current key decrypts only what it encrypted ("new-key:…").
      cipher: {
        decrypt: async (r: { ciphertext: string }) => {
          if (!r.ciphertext.startsWith("new-key:")) throw new Error("bad auth tag");
          return "plain";
        },
      } as never,
    },
  };
}

describe("desktop licence secret repair", () => {
  it("re-promotes the signed baked token when the stored one no longer decrypts", async () => {
    const d = deps(row("old-key:ciphertext"));
    const r = await bootstrap(d.deps, TENANT, { repairOnly: true });
    expect(r).toEqual({ ok: true, data: { migrated: true } });
    expect(d.put).toHaveBeenCalledWith(TENANT, "license.token.current", "signed.baked.token");
  });

  it("leaves a readable token alone", async () => {
    const d = deps(row("new-key:ciphertext"));
    expect(await bootstrap(d.deps, TENANT, { repairOnly: true })).toEqual({
      ok: true,
      data: { migrated: false },
    });
    expect(d.put).not.toHaveBeenCalled();
  });

  it("repair mode never promotes a licence that was not activated", async () => {
    const d = deps(null);
    expect(await bootstrap(d.deps, TENANT, { repairOnly: true })).toEqual({
      ok: true,
      data: { migrated: false },
    });
    expect(d.put).not.toHaveBeenCalled();
    // Activation (no repairOnly) still promotes it, as before.
    expect((await bootstrap(d.deps, TENANT)).data).toEqual({ migrated: true });
  });
});
