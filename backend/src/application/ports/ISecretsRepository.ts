/**
 * Phase 0 — Platform Foundation: secrets repository port.
 *
 * Stores encrypted-at-rest key-value pairs. The plaintext value is
 * never persisted; only ciphertext, iv, and auth tag are stored in
 * the `secrets` table. The encryption is performed by the
 * `ISecretCipher` adapter (see backend/src/application/ports/ISecretCipher.ts).
 *
 * Two scopes:
 *  - tenant-scoped secrets: pass `tenantId` to scope the row.
 *  - system-level secrets: pass `tenantId = null`. The RLS policy on
 *    `secrets` allows these rows to be read by every tenant.
 *
 * The `key` is a free-form lookup string. Convention:
 *   - `license.token.<activation_id>` — the EdDSA-signed offline token
 *   - `license.signing.public` — the public half of the License Server
 *     keypair, system-level (the customer install needs it to verify
 *     tokens without an HTTP call to the License Server)
 *   - `app.master_key.fingerprint` — SHA-256 of the current master key,
 *     system-level, used to detect whether a rotation actually changed
 *     the underlying key
 */
export interface SecretRecord {
  id: string;
  tenantId: string | null;
  key: string;
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string | null; // base64
  algorithm: string;
  version: number;
  rotatedAt: Date | null;
  createdAt: Date;
}

export interface ISecretsRepository {
  /** Get a single secret by tenant scope and key. Returns null if absent. */
  get(tenantId: string | null, key: string): Promise<SecretRecord | null>;

  /**
   * Encrypt `plaintext` with the active master key and persist it under
   * `(tenantId, key)`. If a row already exists, its `version` is
   * incremented and `rotatedAt` is set. Returns the new version.
   */
  put(tenantId: string | null, key: string, plaintext: string): Promise<number>;

  /** Delete a secret. No-op if not found. */
  delete(tenantId: string | null, key: string): Promise<void>;

  /**
   * Re-encrypt every secret with the new master key. The new key is
   * adopted by the cipher (see `ISecretCipher.rotate`) BEFORE this
   * method is called.
   *
   * Returns the number of secrets re-encrypted. The implementation
   * MUST be transaction-safe (all rows in one tx or each row in its
   * own tx with idempotency on error).
   */
  rotateAll(newMasterKey: Buffer): Promise<number>;
}
