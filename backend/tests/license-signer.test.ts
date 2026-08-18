import { describe, it, expect, beforeAll } from "vitest";
import { LicenseTokenSigner } from "@/infrastructure/auth/LicenseTokenSigner";

describe("LicenseTokenSigner", () => {
  let signer: LicenseTokenSigner;
  let publicOnlySigner: LicenseTokenSigner;

  beforeAll(async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);
    publicOnlySigner = await LicenseTokenSigner.fromJwk(publicJwk);
  });

  it("generates a valid Ed25519 keypair", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    expect(privateJwk.kty).toBe("OKP");
    expect(privateJwk.crv).toBe("Ed25519");
    expect(publicJwk.kty).toBe("OKP");
    const s = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);
    const tok = await s.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: ["f1"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "fp",
    });
    expect(typeof tok).toBe("string");
    expect(tok.split(".").length).toBe(3);
  });

  it("round-trips a token and verifies the payload", async () => {
    const tok = await signer.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: ["erp.core", "license.audit"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "abc123",
    });
    const v = await signer.verify(tok);
    expect(v.payload.licenseId).toBe("l1");
    expect(v.payload.tenantId).toBe("t1");
    expect(v.payload.features).toEqual(["erp.core", "license.audit"]);
    expect(v.payload.serverFingerprint).toBe("abc123");
    expect(v.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("public-only signer can verify but not sign", async () => {
    const tok = await signer.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: [],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "x",
    });
    const v = await publicOnlySigner.verify(tok);
    expect(v.payload.licenseId).toBe("l1");
    await expect(
      publicOnlySigner.sign({
        licenseId: "l1",
        tenantId: "t1",
        features: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        serverFingerprint: "x",
      }),
    ).rejects.toThrow(/without a private key/);
  });

  it("rejects a token signed with a different key", async () => {
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    const other = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);
    const tok = await other.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: [],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "x",
    });
    await expect(signer.verify(tok)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const tok = await signer.sign({
      licenseId: "l1",
      tenantId: "t1",
      features: [],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      serverFingerprint: "x",
    });
    const [h, p, s] = tok.split(".");
    // Flip one char in the payload.
    const tamperedP = p.slice(0, 5) + (p[5] === "a" ? "b" : "a") + p.slice(6);
    const tampered = `${h}.${tamperedP}.${s}`;
    await expect(signer.verify(tampered)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const tok = await signer.sign(
      {
        licenseId: "l1",
        tenantId: "t1",
        features: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        serverFingerprint: "x",
      },
      { expiresInSec: -1 },
    );
    await expect(signer.verify(tok)).rejects.toThrow();
  });
});
