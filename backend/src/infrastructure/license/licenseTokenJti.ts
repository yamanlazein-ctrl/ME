import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { ILicenseTokenSigner } from "../../application/ports/ILicenseTokenSigner.js";

/**
 * Canonical offline-license jti resolution (Phase 8).
 *
 * Source of truth order:
 *   1. `licenses.offline_token_jti` (Vendor SoT column)
 *   2. decrypted `secrets.license.token.jti` (ERP cache)
 *   3. jti claim from verifying the offline token (secrets or SoT row)
 *
 * For revocation, every discovered jti is denylisted so drift between SoT
 * and secrets cannot leave a stale grant usable.
 */
export async function collectOfflineTokenJtisForDenylist(input: {
  licenseOfflineTokenJti: string | null | undefined;
  licenseOfflineToken: string | null | undefined;
  tenantId: string;
  secretsRepo: ISecretsRepository;
  cipher: ISecretCipher;
  signer: ILicenseTokenSigner;
}): Promise<string[]> {
  const jtis = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) jtis.add(trimmed);
  };

  add(input.licenseOfflineTokenJti);

  const jtiRow = await input.secretsRepo.get(input.tenantId, "license.token.jti");
  if (jtiRow) {
    try {
      const plain = await input.cipher.decrypt({
        ciphertext: jtiRow.ciphertext,
        iv: jtiRow.iv,
        authTag: jtiRow.authTag,
        algorithm: jtiRow.algorithm,
      });
      add(plain);
    } catch {
      /* ignore corrupt secret */
    }
  }

  const tokenRow = await input.secretsRepo.get(input.tenantId, "license.token.current");
  let tokenPlain: string | null = null;
  if (tokenRow) {
    try {
      tokenPlain = await input.cipher.decrypt({
        ciphertext: tokenRow.ciphertext,
        iv: tokenRow.iv,
        authTag: tokenRow.authTag,
        algorithm: tokenRow.algorithm,
      });
    } catch {
      tokenPlain = null;
    }
  } else {
    tokenPlain = input.licenseOfflineToken ?? null;
  }

  if (tokenPlain) {
    try {
      const v = await input.signer.verify(tokenPlain);
      add(v.jti);
    } catch {
      /* ignore invalid token */
    }
  }

  return [...jtis];
}

/** Prefer SoT column; fall back to first collected jti. */
export function primaryOfflineTokenJti(
  licenseOfflineTokenJti: string | null | undefined,
  collected: string[],
): string | null {
  const fromSoT = licenseOfflineTokenJti?.trim();
  if (fromSoT) return fromSoT;
  return collected[0] ?? null;
}
