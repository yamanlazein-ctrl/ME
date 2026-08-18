/**
 * Phase 0 — Platform Foundation: secret cipher port.
 *
 * Symmetric encryption adapter. The default implementation
 * (AesGcmSecretStore) is AES-256-GCM. A new implementation can be
 * plugged in by editing `infrastructure/secrets/AesGcmSecretStore.ts`
 * (no other code change required).
 *
 * Design notes:
 *  - `encrypt` returns the IV and auth tag alongside the ciphertext.
 *    The caller is responsible for persisting all three (the
 *    `secrets` table has columns for each).
 *  - `decrypt` validates the auth tag and throws on tamper.
 *  - `rotate` swaps the master key in-memory. Existing ciphertexts
 *    must be re-encrypted by the caller (see
 *    `ISecretsRepository.rotateAll`).
 *  - The cipher holds the master key in process memory. It is read
 *    from the `APP_MASTER_KEY` env on startup. To rotate, the
 *    `rotateMasterKey` route passes a new key into `rotate`.
 */
export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string | null; // base64; null for non-AEAD algorithms
  algorithm: string; // e.g. "aes-256-gcm"
}

export interface ISecretCipher {
  /** Encrypt a UTF-8 string. */
  encrypt(plaintext: string): Promise<EncryptedSecret>;

  /** Decrypt a record produced by `encrypt`. Throws on tamper / bad key. */
  decrypt(record: EncryptedSecret): Promise<string>;

  /**
   * Adopt a new master key. Subsequent encrypt/decrypt calls use it.
   * The caller is responsible for re-encrypting all persisted secrets.
   */
  rotate(newMasterKey: Buffer): Promise<void>;

  /** SHA-256 hex of the current master key, for fingerprinting. */
  fingerprint(): Promise<string>;
}
