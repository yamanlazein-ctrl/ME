import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID as cryptoRandomUUID,
  type KeyObject,
} from "node:crypto";
import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK, type JWK } from "jose";
import type {
  BindingType,
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";

/**
 * Phase 0 sub-batch 0E — EdDSA license token signer.
 *
 * Signs offline license tokens with EdDSA (Ed25519). Separate from
 * the user-JWT `JwtSigner` (HS256 + JWT_SECRET) so the two signing
 * realms cannot be confused (per PLATFORM_FOUNDATION_NOTES.md §6).
 *
 * The customer install only needs the public key (in PEM or JWK
 * form). The License Server (sub-batch 0J) holds the private key.
 *
 * Token payload (frozen spec §3): the full license metadata is signed so the
 * offline Windows client can enforce features/limits/policies without a live
 * call. Plus standard JWT claims: iat, exp, jti.
 */
export interface LicenseTokenPayload {
  licenseId: string;
  tenantId: string;
  features: string[];
  expiresAt: number; // epoch seconds
  serverFingerprint: string;
  // ── License Engine extensions (frozen spec §3) ──
  edition: string;
  plan: string;
  licenseVersion: string;
  productVersion: string;
  licenseModel: LicenseModel;
  bindingType: BindingType | string;
  bindingValue: string;
  limits: LicenseLimits;
  transferPolicy: TransferPolicy;
  updatePolicy: UpdatePolicy;
  backupPolicy: BackupPolicy;
}

export interface LicenseTokenVerification {
  payload: LicenseTokenPayload;
  jti: string;
  iat: number;
  exp: number;
}

export class LicenseTokenSigner {
  private readonly privateKeyJwk: JWK | null;
  private readonly publicKeyJwk: JWK;
  private readonly kid: string;

  constructor(privateKeyJwk: JWK | null, publicKeyJwk: JWK) {
    this.privateKeyJwk = privateKeyJwk;
    this.publicKeyJwk = publicKeyJwk;
    this.kid = publicKeyJwk.kid ?? computeKid(publicKeyJwk);
  }

  /**
   * Construct from PEM strings (the form stored in `LICENSE_SIGNING_KEY` /
   * `LICENSE_SIGNING_PUBLIC_KEY`).
   *
   * Both signing and verification work: Node converts an Ed25519 PEM to a JWK
   * (`export({ format: "jwk" })`) and `jose` imports that JWK directly.
   *
   * Two operational details this handles so a correct `.env` cannot fail at
   * boot:
   * - **Escaped newlines.** A PEM is multi-line. Inside a `.env` file dotenv
   *   accepts both a real multi-line quoted value and a single line with `\n`
   *   escapes, but a value exported directly into the process environment
   *   keeps the literal backslash-n. `normalizePem` restores real newlines so
   *   both forms behave identically.
   * - **Public key omitted.** The public key is derivable from the private
   *   key, so an operator only has to persist ONE secret. Previously the
   *   caller passed `?? ""` and `createPublicKey("")` threw
   *   `DECODER routines::unsupported`, crashing startup for an otherwise
   *   valid configuration.
   */
  static fromPems(privateKeyPem: string | null, publicKeyPem: string): LicenseTokenSigner {
    const privPem = normalizePem(privateKeyPem);
    const pubPem = normalizePem(publicKeyPem);

    // R5: load the private key too, so the PEM path can SIGN (previously
    // it was verification-only). A malformed private PEM degrades to a
    // verifier-only signer rather than crashing startup.
    let privateJwk: JWK | null = null;
    let privateKeyObj: KeyObject | null = null;
    if (privPem) {
      try {
        privateKeyObj = createPrivateKey(privPem);
        privateJwk = nodeKeyToJwk(privateKeyObj);
      } catch {
        privateJwk = null;
        privateKeyObj = null;
      }
    }

    // Prefer the explicitly configured public key; otherwise derive it from
    // the private key so a single persisted secret is enough.
    let publicJwk: JWK;
    if (pubPem) {
      publicJwk = nodeKeyToJwk(createPublicKey(pubPem));
    } else if (privateKeyObj) {
      publicJwk = nodeKeyToJwk(createPublicKey(privateKeyObj));
    } else {
      throw new Error(
        "LicenseTokenSigner.fromPems: neither a usable private key nor a public key was provided",
      );
    }

    return new LicenseTokenSigner(privateJwk, publicJwk);
  }

  static async fromJwk(publicJwk: JWK, privateJwk?: JWK): Promise<LicenseTokenSigner> {
    return new LicenseTokenSigner(privateJwk ?? null, publicJwk);
  }

  static async generateKeyPair(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    publicJwk.kid = computeKid(publicJwk);
    privateJwk.kid = publicJwk.kid;
    return { privateJwk, publicJwk };
  }

  async sign(
    payload: LicenseTokenPayload,
    opts?: { expiresInSec?: number; jti?: string },
  ): Promise<string> {
    if (!this.privateKeyJwk) {
      throw new Error("LicenseTokenSigner: cannot sign without a private key");
    }
    const key = await importJWK(this.privateKeyJwk, "EdDSA");
    const expiresInSec = opts?.expiresInSec ?? 7 * 24 * 60 * 60; // 7 days
    const jti = opts?.jti ?? randomUUID();
    return new SignJWT({
      license_id: payload.licenseId,
      tenant_id: payload.tenantId,
      features: payload.features,
      expires_at: payload.expiresAt,
      server_fingerprint: payload.serverFingerprint,
      edition: payload.edition,
      plan: payload.plan,
      license_version: payload.licenseVersion,
      product_version: payload.productVersion,
      license_model: payload.licenseModel,
      binding_type: payload.bindingType,
      binding_value: payload.bindingValue,
      limits: payload.limits,
      transfer_policy: payload.transferPolicy,
      update_policy: payload.updatePolicy,
      backup_policy: payload.backupPolicy,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.kid, typ: "LIC" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSec)
      .setJti(jti)
      .sign(key);
  }

  async verify(token: string): Promise<LicenseTokenVerification> {
    const key = await importJWK(this.publicKeyJwk, "EdDSA");
    const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"], typ: "LIC" });
    const p = payload as unknown as {
      license_id: string;
      tenant_id: string;
      features: string[];
      expires_at: number;
      server_fingerprint: string;
      edition: string;
      plan: string;
      license_version: string;
      product_version: string;
      license_model: LicenseModel;
      binding_type: string;
      binding_value: string;
      limits: LicenseLimits;
      transfer_policy: TransferPolicy;
      update_policy: UpdatePolicy;
      backup_policy: BackupPolicy;
      jti: string;
      iat: number;
      exp: number;
    };
    return {
      payload: {
        licenseId: p.license_id,
        tenantId: p.tenant_id,
        features: p.features,
        expiresAt: p.expires_at,
        serverFingerprint: p.server_fingerprint,
        edition: p.edition,
        plan: p.plan,
        licenseVersion: p.license_version,
        productVersion: p.product_version,
        licenseModel: p.license_model,
        bindingType: p.binding_type,
        bindingValue: p.binding_value,
        limits: p.limits,
        transferPolicy: p.transfer_policy,
        updatePolicy: p.update_policy,
        backupPolicy: p.backup_policy,
      },
      jti: p.jti,
      iat: p.iat,
      exp: p.exp,
    };
  }
}

function computeKid(jwk: JWK): string {
  return createHash("sha256").update(JSON.stringify(jwk)).digest("hex").slice(0, 16);
}

/**
 * Accept a PEM whose newlines were escaped as the two characters `\` + `n`
 * (unavoidable when a multi-line key travels through a shell env var), and
 * treat blank/whitespace-only input as absent.
 */
function normalizePem(pem: string | null | undefined): string | null {
  if (!pem) return null;
  const normalized = pem.replace(/\\n/g, "\n").trim();
  return normalized === "" ? null : normalized;
}

function nodeKeyToJwk(nodeKey: unknown): JWK {
  const jwk = (nodeKey as { export: (o: { format: string }) => string | Buffer }).export({
    format: "jwk",
  });
  return jwk as JWK;
}

function randomUUID(): string {
  return cryptoRandomUUID();
}
