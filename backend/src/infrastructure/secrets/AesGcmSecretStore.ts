import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import type { EncryptedSecret, ISecretCipher } from "../../application/ports/ISecretCipher.js";

/**
 * Phase 0 — Platform Foundation: AES-256-GCM secret cipher.
 *
 * Default `ISecretCipher` implementation. Uses Node's built-in `crypto`
 * (no extra dep). The cipher is initialised with `APP_MASTER_KEY` from
 * env (32 bytes, base64). IVs are 12 bytes (GCM-recommended) and are
 * regenerated on every encrypt call.
 *
 * The 16-byte GCM auth tag is stored in a separate column on `secrets`
 * (`auth_tag`) so the schema is forward-compatible with non-AEAD
 * algorithms.
 */
export class AesGcmSecretStore implements ISecretCipher {
  /** 32 bytes = AES-256. */
  private static readonly KEY_BYTES = 32;
  /** 12 bytes = GCM-recommended. */
  private static readonly IV_BYTES = 12;
  private static readonly ALG = "aes-256-gcm";
  private static readonly AUTH_TAG_BYTES = 16;

  private key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== AesGcmSecretStore.KEY_BYTES) {
      throw new Error(
        `APP_MASTER_KEY must decode to ${AesGcmSecretStore.KEY_BYTES} bytes; got ${masterKey.length}`,
      );
    }
    this.key = masterKey;
  }

  async encrypt(plaintext: string): Promise<EncryptedSecret> {
    const iv = randomBytes(AesGcmSecretStore.IV_BYTES);
    const cipher = createCipheriv(AesGcmSecretStore.ALG, this.key, iv, {
      authTagLength: AesGcmSecretStore.AUTH_TAG_BYTES,
    });
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: enc.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      algorithm: AesGcmSecretStore.ALG,
    };
  }

  async decrypt(record: EncryptedSecret): Promise<string> {
    if (record.algorithm !== AesGcmSecretStore.ALG) {
      throw new Error(`Unsupported secret algorithm: ${record.algorithm}`);
    }
    if (!record.authTag) {
      throw new Error("Missing auth tag for GCM record");
    }
    const iv = Buffer.from(record.iv, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    const authTag = Buffer.from(record.authTag, "base64");
    const decipher = createDecipheriv(AesGcmSecretStore.ALG, this.key, iv, {
      authTagLength: AesGcmSecretStore.AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return dec.toString("utf8");
  }

  async rotate(newMasterKey: Buffer): Promise<void> {
    if (newMasterKey.length !== AesGcmSecretStore.KEY_BYTES) {
      throw new Error(
        `New APP_MASTER_KEY must decode to ${AesGcmSecretStore.KEY_BYTES} bytes; got ${newMasterKey.length}`,
      );
    }
    this.key = newMasterKey;
  }

  async fingerprint(): Promise<string> {
    return createHash("sha256").update(this.key).digest("hex");
  }
}

/**
 * Helper: read a 32-byte master key from a base64 env var. Returns
 * null if the env is missing or invalid. Callers should fail fast in
 * production when the key is missing.
 */
export function decodeMasterKey(envValue: string | undefined): Buffer | null {
  if (!envValue) return null;
  try {
    const buf = Buffer.from(envValue, "base64");
    return buf.length === AesGcmSecretStore["KEY_BYTES"] ? buf : null;
  } catch {
    return null;
  }
}
