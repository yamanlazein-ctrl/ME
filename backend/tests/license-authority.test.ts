import { describe, expect, it } from "vitest";
import {
  decideEntitlementRefreshAction,
  isTerminalLicenseStatus,
  LICENSE_AUTHORITY,
} from "../src/domain/licensing/licenseAuthority.js";
import { LicenseTokenSigner } from "../src/infrastructure/auth/LicenseTokenSigner.js";

describe("licenseAuthority — Phase 8 boundary", () => {
  it("marks licenses_sot as vendor-owned and non-mutable by customer org", () => {
    expect(LICENSE_AUTHORITY.licenses_sot.plane).toBe("vendor");
    expect(LICENSE_AUTHORITY.licenses_sot.mutableByCustomerOrg).toBe(false);
    expect(LICENSE_AUTHORITY.tenant_entitlement_cache.plane).toBe("local_erp");
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalLicenseStatus("suspended")).toBe(true);
    expect(isTerminalLicenseStatus("revoked")).toBe(true);
    expect(isTerminalLicenseStatus("expired")).toBe(true);
    expect(isTerminalLicenseStatus("active")).toBe(false);
  });

  it("decides resign vs revoke for entitlement refresh", () => {
    expect(decideEntitlementRefreshAction("active")).toBe("resign");
    expect(decideEntitlementRefreshAction("trial")).toBe("resign");
    expect(decideEntitlementRefreshAction("suspended")).toBe("revoke");
    expect(decideEntitlementRefreshAction("revoked")).toBe("revoke");
    expect(decideEntitlementRefreshAction("expired")).toBe("revoke");
    expect(decideEntitlementRefreshAction("unknown")).toBe("noop");
  });
});

describe("LicenseTokenSigner.canSign", () => {
  it("is false for public-only (desktop) signer", async () => {
    const { publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const verifyOnly = await LicenseTokenSigner.fromJwk(publicJwk);
    expect(verifyOnly.canSign()).toBe(false);
  });

  it("is true when private key is present", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);
    expect(signer.canSign()).toBe(true);
  });
});
