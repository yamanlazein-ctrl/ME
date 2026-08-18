import { eq, and, isNull } from "drizzle-orm";
import { db as defaultDb, withTenantTx, type DB } from "../orm/drizzle.js";
import { secrets } from "../orm/schemas/secret.table.js";
import type { ISecretCipher, EncryptedSecret } from "../../application/ports/ISecretCipher.js";
import type {
  ISecretsRepository,
  SecretRecord,
} from "../../application/ports/ISecretsRepository.js";

/**
 * Phase 0 — Platform Foundation: Postgres implementation of
 * `ISecretsRepository`. Stores ciphertext + IV + auth tag in the
 * `secrets` table; encrypts/decrypts via the injected `ISecretCipher`
 * (typically `AesGcmSecretStore`).
 *
 * Two scopes:
 *  - `tenantId != null`: tenant-scoped (RLS USING/WITH CHECK on the
 *    column `tenant_id = current_setting('app.current_tenant_id')`).
 *    Calls are wrapped in `withTenantTx` so the GUC is set on the
 *    same connection that issues the query.
 *  - `tenantId == null`: system-level. Reads bypass `withTenantTx`
 *    (no tenant to scope to) and rely on the policy's NULL allowance
 *    (`(tenant_id IS NULL) OR (tenant_id = current_setting(...))`).
 *    Writes also bypass the tx since NULL is allowed regardless of
 *    the current tenant GUC.
 */
export class PostgresSecretsRepository implements ISecretsRepository {
  constructor(
    private readonly cipher: ISecretCipher,
    private readonly db: DB = defaultDb,
  ) {}

  async get(tenantId: string | null, key: string): Promise<SecretRecord | null> {
    if (tenantId === null) {
      return this.getSystemLevel(key);
    }
    return withTenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(secrets)
        .where(and(eq(secrets.tenantId, tenantId), eq(secrets.key, key)))
        .limit(1);
      return row ? toRecord(row) : null;
    });
  }

  async put(tenantId: string | null, key: string, plaintext: string): Promise<number> {
    const enc = await this.cipher.encrypt(plaintext);
    if (tenantId === null) {
      return this.putSystemLevel(key, enc);
    }
    return withTenantTx(tenantId, async (tx) => {
      // Upsert: increment version on collision.
      const [existing] = await tx
        .select({ id: secrets.id, version: secrets.version })
        .from(secrets)
        .where(and(eq(secrets.tenantId, tenantId), eq(secrets.key, key)))
        .limit(1);

      if (existing) {
        await tx
          .update(secrets)
          .set({
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            authTag: enc.authTag,
            algorithm: enc.algorithm,
            version: existing.version + 1,
            rotatedAt: new Date(),
          })
          .where(eq(secrets.id, existing.id));
        return existing.version + 1;
      }

      const [row] = await tx
        .insert(secrets)
        .values({
          tenantId,
          key,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          algorithm: enc.algorithm,
          version: 1,
        })
        .returning({ version: secrets.version });
      return row!.version;
    });
  }

  async delete(tenantId: string | null, key: string): Promise<void> {
    if (tenantId === null) {
      await this.db.delete(secrets).where(and(isNull(secrets.tenantId), eq(secrets.key, key)));
      return;
    }
    await withTenantTx(tenantId, async (tx) => {
      await tx
        .delete(secrets)
        .where(and(eq(secrets.tenantId, tenantId), eq(secrets.key, key)));
    });
  }

  async rotateAll(newMasterKey: Buffer): Promise<number> {
    // Adopt the new key FIRST so the test encrypt call below uses it.
    await this.cipher.rotate(newMasterKey);

    // Read all rows outside any tenant scope (system-level), re-encrypt
    // each, write back. Tenant-scoped rows are also re-encrypted; the
    // GUC scoping on UPDATE is bypassed because we operate as
    // superuser (per the project's DATABASE_URL), but the
    // FORCE RLS policy would still apply. To bypass it for the
    // duration of the rotation we set the GUC to the row's own
    // tenant_id before updating. This is a small N+1; rotation
    // happens rarely (admin action) so it is acceptable.
    const allRows = await this.db
      .select()
      .from(secrets);

    let count = 0;
    for (const row of allRows) {
      const enc = await this.cipher.encrypt(
        await this.cipher.decrypt({
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
          algorithm: row.algorithm,
        }),
      );

      if (row.tenantId === null) {
        await this.db
          .update(secrets)
          .set({
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            authTag: enc.authTag,
            algorithm: enc.algorithm,
            version: row.version + 1,
            rotatedAt: new Date(),
          })
          .where(eq(secrets.id, row.id));
      } else {
        await withTenantTx(row.tenantId, async (tx) => {
          await tx
            .update(secrets)
            .set({
              ciphertext: enc.ciphertext,
              iv: enc.iv,
              authTag: enc.authTag,
              algorithm: enc.algorithm,
              version: row.version + 1,
              rotatedAt: new Date(),
            })
            .where(eq(secrets.id, row.id));
        });
      }
      count++;
    }
    return count;
  }

  // ── System-level (tenantId IS NULL) helpers ──────────────────

  private async getSystemLevel(key: string): Promise<SecretRecord | null> {
    const [row] = await this.db
      .select()
      .from(secrets)
      .where(and(isNull(secrets.tenantId), eq(secrets.key, key)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  private async putSystemLevel(key: string, enc: EncryptedSecret): Promise<number> {
    const [existing] = await this.db
      .select({ id: secrets.id, version: secrets.version })
      .from(secrets)
      .where(and(isNull(secrets.tenantId), eq(secrets.key, key)))
      .limit(1);

    if (existing) {
      await this.db
        .update(secrets)
        .set({
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          algorithm: enc.algorithm,
          version: existing.version + 1,
          rotatedAt: new Date(),
        })
        .where(eq(secrets.id, existing.id));
      return existing.version + 1;
    }

    const [row] = await this.db
      .insert(secrets)
      .values({
        tenantId: null,
        key,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        algorithm: enc.algorithm,
        version: 1,
      })
      .returning({ version: secrets.version });
    return row!.version;
  }
}

type Row = typeof secrets.$inferSelect;
function toRecord(row: Row): SecretRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    algorithm: row.algorithm,
    version: row.version,
    rotatedAt: row.rotatedAt,
    createdAt: row.createdAt,
  };
}
