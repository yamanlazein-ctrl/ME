import { sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { engineDb } from "../orm/engineSchema.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type { ISecretCipher } from "../../application/ports/ISecretCipher.js";
import type { ISecretsRepository } from "../../application/ports/ISecretsRepository.js";
import type { ILicenseRepository } from "../../application/ports/ILicenseRepository.js";
import { getHubEpoch } from "../../application/use-cases/sync/hubIdentity.js";
import { isHubWriteFrozen } from "../http/middleware/hubWriteFreeze.middleware.js";

/**
 * MIG-08 — run on the NEW host before DNS is switched (docs/HUB-MIGRATION-RUNBOOK.md). A new
 * server can hold all the data and still fail every client: a different APP_MASTER_KEY leaves the
 * hub's encrypted secrets (device credentials) unreadable, no licence blocks the API, a CORS list
 * without the web origin refuses the browser, and devices whose credentials did not travel
 * (secrets are not in a portable backup) cannot sign in.
 */
export type PreflightCheck = {
  name: string;
  status: "ok" | "warning" | "failed";
  detail: string;
};

type Deps = {
  secretsRepo: ISecretsRepository;
  secretCipher: ISecretCipher;
  licenseRepo: ILicenseRepository;
};

const rowsOf = (r: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;

export async function cutoverPreflight(
  deps: Deps,
  tenantId: string,
): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
  const checks: PreflightCheck[] = [];

  checks.push(
    config.JWT_SECRET && config.JWT_SECRET.length >= 32
      ? { name: "jwt-secret", status: "ok", detail: "JWT_SECRET set (≥ 32 chars)" }
      : { name: "jwt-secret", status: "failed", detail: "JWT_SECRET missing or shorter than 32" },
  );

  const cors = String(config.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const onlyLocal = cors.every((o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  checks.push(
    config.DESKTOP_DEPLOY || !onlyLocal
      ? { name: "cors-origin", status: "ok", detail: cors.join(", ") }
      : {
          name: "cors-origin",
          status: "warning",
          detail:
            "CORS_ORIGIN lists only localhost — a web client served from another origin will be refused",
        },
  );

  await runWithTenantContext({ tenantId }, async () => {
    const db = await engineDb();
    // Every encrypted secret of this company must decrypt with THIS host's APP_MASTER_KEY.
    const secrets = rowsOf(
      await db.execute(
        sql`SELECT key, ciphertext, iv, auth_tag, algorithm FROM secrets WHERE tenant_id = ${tenantId}`,
      ),
    );
    let unreadable = 0;
    for (const s of secrets) {
      try {
        await deps.secretCipher.decrypt({
          ciphertext: String(s.ciphertext),
          iv: String(s.iv),
          authTag: s.auth_tag == null ? null : String(s.auth_tag),
          algorithm: String(s.algorithm),
        });
      } catch {
        unreadable++;
      }
    }
    checks.push(
      unreadable === 0
        ? { name: "master-key", status: "ok", detail: `${secrets.length} secret(s) readable` }
        : {
            name: "master-key",
            status: "failed",
            detail: `${unreadable}/${secrets.length} secret(s) cannot be decrypted — APP_MASTER_KEY differs from the old host`,
          },
    );

    // Enrolled devices whose hub credential did not travel with the data.
    const devices = rowsOf(
      await db.execute(
        sql`SELECT id FROM sync_devices WHERE tenant_id = ${tenantId} AND revoked_at IS NULL`,
      ),
    ).map((r) => String(r.id));
    const withCred = new Set(
      secrets
        .map((s) => String(s.key))
        .filter((k) => k.startsWith("sync.device.cred."))
        .map((k) => k.slice("sync.device.cred.".length)),
    );
    const missing = devices.filter((d) => !withCred.has(d));
    checks.push(
      missing.length === 0
        ? { name: "device-credentials", status: "ok", detail: `${devices.length} device(s)` }
        : {
            name: "device-credentials",
            status: "warning",
            detail: `${missing.length}/${devices.length} device(s) have no hub credential here (a portable backup does not carry them): those devices sign in with their account or must re-enroll`,
          },
    );
  });

  const lic = await deps.licenseRepo.findLatestForTenant(tenantId as never);
  const expired = lic?.expiresAt ? lic.expiresAt.getTime() < Date.now() : false;
  checks.push(
    !lic
      ? { name: "license", status: "failed", detail: "no licence for this company on this host" }
      : lic.status !== "active" || expired
        ? {
            name: "license",
            status: "failed",
            detail: `licence ${lic.status}${expired ? " (expired)" : ""}`,
          }
        : { name: "license", status: "ok", detail: "active" },
  );

  const epoch = await getHubEpoch(deps, tenantId);
  checks.push({ name: "hub-epoch", status: "ok", detail: `${epoch.epoch} (${epoch.reason})` });
  checks.push({
    name: "write-freeze",
    status: "ok",
    detail: isHubWriteFrozen()
      ? "frozen (HUB_WRITE_FREEZE=1) — unfreeze after verification"
      : "not frozen",
  });

  return { ok: checks.every((c) => c.status !== "failed"), checks };
}
