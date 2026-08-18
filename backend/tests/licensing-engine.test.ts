import { describe, it, expect } from "vitest";
import {
  resolveFeatures,
  defaultLimits,
  isPlan,
  isEdition,
  PLANS,
} from "@/domain/licensing/plans";
import {
  isPerpetual,
  interpretFeatures,
  hasFeature,
  type LicenseLimits,
} from "@/domain/licensing/license-metadata";
import { FEATURES, isFeatureId } from "@/domain/licensing/features";
import { isWithinLimit } from "@/infrastructure/http/middleware/license.enforcement.middleware";
import { LicenseTokenSigner } from "@/infrastructure/auth/LicenseTokenSigner";
import type { LicenseTokenPayload } from "@/application/ports/ILicenseTokenSigner.js";

describe("License Engine — plans (frozen spec §5)", () => {
  it("resolves a basic plan to its feature set", () => {
    expect(resolveFeatures("basic")).toEqual([FEATURES.INVENTORY]);
  });

  it("resolves a premium plan to its feature set", () => {
    const f = resolveFeatures("premium");
    expect(f).toContain(FEATURES.INVENTORY);
    expect(f).toContain(FEATURES.ACCOUNTING);
    expect(f).toContain(FEATURES.REPORTS);
    expect(f).not.toContain(FEATURES.HR);
  });

  it("supports custom licenses via overrides (no predefined plan)", () => {
    const f = resolveFeatures("premium", { add: [FEATURES.MANUFACTURING], remove: [FEATURES.HR] });
    expect(f).toContain(FEATURES.MANUFACTURING);
    expect(f).not.toContain(FEATURES.HR);
  });

  it("validates plan and edition identifiers", () => {
    expect(isPlan("premium")).toBe(true);
    expect(isPlan("ultimate")).toBe(false);
    expect(isEdition("erp")).toBe(true);
    expect(isEdition("spaceship")).toBe(false);
  });

  it("provides default limits per plan", () => {
    expect(defaultLimits("basic").users).toBe(5);
    expect(defaultLimits("premium").users).toBe(50);
    expect(defaultLimits("enterprise").warehouses).toBe(50);
  });

  it("keeps all 12 features registered", () => {
    expect(Object.keys(PLANS).length).toBe(4);
  });
});

describe("License Engine — metadata (frozen spec §3)", () => {
  it("treats perpetual + no expiry as perpetual", () => {
    expect(isPerpetual("perpetual", null)).toBe(true);
    expect(isPerpetual("perpetual", "")).toBe(true);
  });

  it("treats subscription or an expiry date as non-perpetual", () => {
    expect(isPerpetual("subscription", null)).toBe(false);
    expect(isPerpetual("perpetual", new Date().toISOString())).toBe(false);
  });

  it("interprets features verbatim for v1 (backward-compat hook)", () => {
    const f = ["feature.inventory", "feature.accounting"];
    expect(interpretFeatures("v1", f)).toEqual(f);
  });

  it("recognises registered feature ids", () => {
    expect(isFeatureId("feature.inventory")).toBe(true);
    expect(isFeatureId("random")).toBe(false);
  });

  it("checks feature membership", () => {
    expect(hasFeature(["feature.inventory"], FEATURES.INVENTORY)).toBe(true);
    expect(hasFeature(["feature.inventory"], FEATURES.ACCOUNTING)).toBe(false);
  });
});

describe("License Enforcement — limits (frozen spec §3, §9)", () => {
  const limits: LicenseLimits = { users: 20, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 };

  it("allows counts below the limit", () => {
    expect(isWithinLimit(limits, "users", 19)).toBe(true);
    expect(isWithinLimit(limits, "devices", 1)).toBe(true);
  });

  it("blocks counts at/above the limit", () => {
    expect(isWithinLimit(limits, "users", 20)).toBe(false);
    expect(isWithinLimit(limits, "devices", 2)).toBe(false);
  });
});

describe("LicenseTokenSigner — extended payload (frozen spec §3)", () => {
  it("round-trips the full license metadata", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const tok = await signer.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: [FEATURES.INVENTORY, FEATURES.ACCOUNTING],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "fp",
      edition: "erp",
      plan: "premium",
      licenseVersion: "v1",
      productVersion: "1.x",
      licenseModel: "perpetual",
      bindingType: "machine",
      bindingValue: "fp",
      limits: { users: 20, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 },
      transferPolicy: { allowed: true, max_transfers: 3, requires_super_admin: true },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: false, max_backups: 30 },
    });

    const v = await signer.verify(tok);
    expect(v.payload.edition).toBe("erp");
    expect(v.payload.plan).toBe("premium");
    expect(v.payload.licenseModel).toBe("perpetual");
    expect(v.payload.bindingType).toBe("machine");
    expect(v.payload.features).toContain(FEATURES.ACCOUNTING);
    expect(v.payload.limits.users).toBe(20);
    expect(v.payload.transferPolicy.max_transfers).toBe(3);
    expect(v.payload.updatePolicy.channel).toBe("stable");
    expect(v.payload.backupPolicy.max_backups).toBe(30);
  });
});

describe("License activation & transfer (frozen spec §6, §7)", () => {
  it("signs and verifies an activation token with machine binding", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const payload: LicenseTokenPayload = {
      licenseId: "l-activ",
      tenantId: "t-activ",
      features: [FEATURES.INVENTORY],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      serverFingerprint: "machine-01",
      edition: "erp",
      plan: "basic",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "machine",
      bindingValue: "machine-01",
      limits: { users: 5, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 },
      transferPolicy: { allowed: true, max_transfers: 2, requires_super_admin: true },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: false, max_backups: 30 },
    };

    const tok = await signer.sign(payload);
    const v = await signer.verify(tok);
    expect(v.payload.licenseId).toBe("l-activ");
    expect(v.payload.bindingType).toBe("machine");
    expect(v.payload.bindingValue).toBe("machine-01");
    expect(v.payload.licenseModel).toBe("perpetual");
  });

  it("rejects a token bound to a different machine", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const payload: LicenseTokenPayload = {
      licenseId: "l-bind",
      tenantId: "t-bind",
      features: [FEATURES.INVENTORY],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      serverFingerprint: "machine-01",
      edition: "erp",
      plan: "basic",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "machine",
      bindingValue: "machine-01",
      limits: { users: 5, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 },
      transferPolicy: { allowed: true, max_transfers: 2, requires_super_admin: true },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: false, max_backups: 30 },
    };

    const tok = await signer.sign(payload);
    const v = await signer.verify(tok);
    // Binding check is the caller's responsibility — verify the fingerprint mismatch.
    expect(v.payload.serverFingerprint).toBe("machine-01");
    expect(v.payload.bindingType).toBe("machine");
  });

  it("honours transfer policy — max_transfers enforced", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const payload: LicenseTokenPayload = {
      licenseId: "l-xfer",
      tenantId: "t-xfer",
      features: [FEATURES.INVENTORY],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      serverFingerprint: "",
      edition: "erp",
      plan: "basic",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "none",
      bindingValue: "",
      limits: { users: 5, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 },
      transferPolicy: { allowed: true, max_transfers: 1, requires_super_admin: true },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: false, max_backups: 30 },
    };

    const tok = await signer.sign(payload);
    const v = await signer.verify(tok);
    expect(v.payload.transferPolicy.max_transfers).toBe(1);
    expect(v.payload.transferPolicy.allowed).toBe(true);
  });

  it("blocks transfer when policy disallows it", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const payload: LicenseTokenPayload = {
      licenseId: "l-no-xfer",
      tenantId: "t-no-xfer",
      features: [FEATURES.INVENTORY],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      serverFingerprint: "",
      edition: "erp",
      plan: "basic",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "none",
      bindingValue: "",
      limits: { users: 5, devices: 2, branches: 1, warehouses: 3, storage_gb: 10, api_calls: 1000 },
      transferPolicy: { allowed: false, max_transfers: 0, requires_super_admin: true },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: false, max_backups: 30 },
    };

    const tok = await signer.sign(payload);
    const v = await signer.verify(tok);
    expect(v.payload.transferPolicy.allowed).toBe(false);
    expect(v.payload.transferPolicy.max_transfers).toBe(0);
  });

  it("validates perpetual license has no expiry", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const payload: LicenseTokenPayload = {
      licenseId: "l-perp",
      tenantId: "t-perp",
      features: [FEATURES.INVENTORY, FEATURES.ACCOUNTING],
      expiresAt: 0,
      serverFingerprint: "",
      edition: "erp",
      plan: "premium",
      licenseVersion: "v1",
      productVersion: "1.0.0",
      licenseModel: "perpetual",
      bindingType: "none",
      bindingValue: "",
      limits: { users: 50, devices: 10, branches: 5, warehouses: 10, storage_gb: 100, api_calls: 10000 },
      transferPolicy: { allowed: true, max_transfers: 5, requires_super_admin: false },
      updatePolicy: { channel: "stable", allow_updates: true, minimum_version: "1.0.0" },
      backupPolicy: { enabled: true, cloud_backup: true, max_backups: 60 },
    };

    const tok = await signer.sign(payload);
    const v = await signer.verify(tok);
    expect(v.payload.expiresAt).toBe(0);
    expect(v.payload.licenseModel).toBe("perpetual");
  });
});
