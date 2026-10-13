import { randomUUID } from "node:crypto";
import type { ISecretsRepository } from "../../ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../ports/ISecretCipher.js";

/**
 * MIG-01 / MIG-02 — the identity of THIS hub instance, per company: the "epoch".
 *
 * Devices used to recognise a hub only by its address + company id, so a hub moved to another
 * server (or restored from a backup) behind the same domain looked identical: no device reset its
 * pull cursor or re-delivered the units the old server had acknowledged, and units numbered below a
 * device's cursor were skipped silently (MIGRATION_READINESS_AUDIT.md).
 *
 * The epoch is a random id that:
 *   - persists across ordinary restarts (stored in the `secrets` table);
 *   - is NEW on another server: `secrets` is never copied by a portable backup
 *     (portableBackup.ts DEVICE_BOUND_TABLES), so a restored hub creates a fresh one;
 *   - is rotated explicitly by every restore path and by the cutover/rollback runbook
 *     (`POST /api/sync/hub/identity/rotate`) — this covers whole-database moves (pg_dump of the
 *     entire cluster) that would otherwise carry the old row along.
 *
 * Devices compare it on every pull; a change triggers the existing, idempotent "new hub" path
 * (cursor reset + re-delivery by op id).
 */
export const HUB_EPOCH_KEY = "sync.hub.epoch";

export type HubEpoch = { epoch: string; createdAt: string; reason: string };

export type HubIdentityDeps = { secretsRepo: ISecretsRepository; secretCipher: ISecretCipher };

async function read(deps: HubIdentityDeps, tenantId: string): Promise<HubEpoch | null> {
  const rec = await deps.secretsRepo.get(tenantId, HUB_EPOCH_KEY);
  if (!rec) return null;
  try {
    const parsed = JSON.parse(await deps.secretCipher.decrypt(rec)) as Partial<HubEpoch>;
    return typeof parsed.epoch === "string" && parsed.epoch
      ? {
          epoch: parsed.epoch,
          createdAt: String(parsed.createdAt ?? ""),
          reason: String(parsed.reason ?? ""),
        }
      : null;
  } catch {
    // Unreadable (e.g. written under another APP_MASTER_KEY): treat as a new instance.
    return null;
  }
}

async function write(deps: HubIdentityDeps, tenantId: string, reason: string): Promise<HubEpoch> {
  const next: HubEpoch = { epoch: randomUUID(), createdAt: new Date().toISOString(), reason };
  await deps.secretsRepo.put(tenantId, HUB_EPOCH_KEY, JSON.stringify(next));
  return next;
}

/** The current epoch, created on first use (a hub that never had one is a new instance). */
export async function getHubEpoch(deps: HubIdentityDeps, tenantId: string): Promise<HubEpoch> {
  return (await read(deps, tenantId)) ?? write(deps, tenantId, "first-use");
}

/** A new epoch: every paired device re-pulls from the start and re-delivers its history. */
export async function rotateHubEpoch(
  deps: HubIdentityDeps,
  tenantId: string,
  reason: string,
): Promise<HubEpoch> {
  return write(deps, tenantId, reason.slice(0, 200) || "rotate");
}
