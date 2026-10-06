/**
 * Restore on a device that already synchronized with a hub (T109; OQ-12, SY-6, SY-7).
 * Owner decision 2026-10-05 (option b): the hub stays unchanged, the restored device takes a NEW
 * sync identity. Ports only — no SQL here.
 *
 * Why a new identity: the hub never returns a caller's own units on pull, and it cannot be asked
 * which op-ids it holds. Under a new identity the hub treats everything the device pushed before —
 * including the work it did AFTER the backup, which the restore wiped locally — as peer units, so:
 *
 *   1. register  sync is paused; a new sync device id is registered on the hub (a new seat) and in
 *                the local registry, with a fingerprint derived from the previous device's;
 *   2. pull      still no push; the device pulls from its restored cursor until the hub has nothing
 *                newer. A pulled unit whose op-id is in this database's outbox is its OWN operation:
 *                its effect is already in the restored data, so it is not re-applied, and an
 *                unsettled outbox unit is acknowledged as `synced` — never pushed again (SY-7).
 *                Every other unit (peers' work and this device's post-backup work) is applied;
 *   3. done      normal sync resumes under the new identity; restored units the hub never received
 *                are pushed as usual. A conflict with newer hub data goes through the existing
 *                conflict review (keep-server / rebase / withdraw).
 */
import { randomUUID } from "node:crypto";
import type { ISyncRestoreStateStore, SyncRestorePhase } from "../../ports/ISyncRestoreStateStore.js";
import type { ISyncOutboxRepository } from "../../ports/ISyncOutboxRepository.js";
import type { ISyncDeviceRepository } from "../../ports/ISyncDeviceRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import type { PulledUnit } from "./syncUseCases.js";

export type RestoreDeviceRegistration = {
  id: string;
  fingerprint: string;
  fingerprintVersion: number;
  platform: string;
  hostname: string | null;
  label: string | null;
};

export type RestoreReconcileDeps = {
  store: ISyncRestoreStateStore;
  outbox: ISyncOutboxRepository;
  devices: ISyncDeviceRepository;
  /** Registers the identity on the hub (hubConfig.registerDeviceOnHub). */
  registerOnHub: (device: RestoreDeviceRegistration) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** One pull page under `syncDeviceId` (runLocalSyncPull with the own-unit hook). */
  pullPage: (
    syncDeviceId: string,
    isOwnRestoredUnit: (unit: PulledUnit) => Promise<boolean>,
  ) => Promise<{ pulled: number; failed: number; acknowledged?: number; deviceTrust?: { code: string; message: string } | null }>;
  /**
   * Number blocks: the restored copies of the previous identities' blocks are stale (those
   * identities kept numbering after the backup, and their documents come back in the pull), so they
   * are retired; the new identity reserves fresh blocks from the hub.
   */
  numberBlocks?: {
    retire: (deviceId: string) => Promise<number>;
    ensure: (deviceId: string) => Promise<void>;
  };
  newId?: () => string;
};

export type RestoreReconcileResult = {
  /** True while sync stays paused for pushes (register or pull not finished). */
  paused: boolean;
  phase: SyncRestorePhase;
  /** The sync identity to use for every hub exchange (null until registered). */
  deviceId: string | null;
  restoredAt: string;
  pulled: number;
  acknowledged: number;
  error: string | null;
};

/** Pull pages per run while reconciling; the next run continues from the cursor. */
const MAX_PULL_PAGES = 200;
const FINGERPRINT_MAX = 128;

export async function reconcileRestoredSnapshot(
  deps: RestoreReconcileDeps,
  ctx: TenantContext,
): Promise<RestoreReconcileResult | null> {
  let state = await deps.store.get();
  if (!state) return null;
  const result = (error: string | null = null): RestoreReconcileResult => ({
    paused: state!.phase !== "done",
    phase: state!.phase,
    deviceId: state!.newDeviceId,
    restoredAt: state!.restoredAt,
    pulled: state!.pulled,
    acknowledged: state!.acknowledged,
    error,
  });
  if (state.phase === "done") return result();

  if (state.phase === "register") {
    const previous = await firstKnownDevice(deps.devices, ctx.tenantId, state.previousDeviceIds);
    const id = (deps.newId ?? randomUUID)();
    const base = previous?.deviceFingerprint ?? `restored-device-${ctx.tenantId}`;
    const suffix = `#r${state.generation}-${id.slice(0, 8)}`;
    const device: RestoreDeviceRegistration = {
      id,
      // A NEW fingerprint: the hub resolves an unknown id by fingerprint, which would hand the
      // previous identity back.
      fingerprint: `${base.slice(0, FINGERPRINT_MAX - suffix.length)}${suffix}`,
      fingerprintVersion: previous?.deviceFingerprintVersion ?? 1,
      platform: previous?.platform ?? "windows",
      hostname: previous?.hostname ?? null,
      label: previous?.label ?? previous?.hostname ?? null,
    };
    const reg = await deps.registerOnHub(device);
    if (!reg.ok) {
      await deps.store.setError(reg.error);
      return result(reg.error);
    }
    await deps.devices.registerOrTouch({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      deviceFingerprint: device.fingerprint,
      deviceFingerprintVersion: device.fingerprintVersion,
      platform: device.platform as Parameters<ISyncDeviceRepository["registerOrTouch"]>[0]["platform"],
      hostname: device.hostname ?? undefined,
      label: device.label ?? undefined,
      deviceId: reg.id,
    });
    if (deps.numberBlocks) {
      for (const prev of state.previousDeviceIds) await deps.numberBlocks.retire(prev);
      try {
        await deps.numberBlocks.ensure(reg.id);
      } catch {
        // best effort: the run's regular block refill retries under the new identity
      }
    }
    await deps.store.setRegistered(reg.id);
    state = (await deps.store.get())!;
  }

  // phase === "pull"
  const deviceId = state.newDeviceId!;
  const isOwn = async (unit: PulledUnit) =>
    (await deps.outbox.acknowledgeByOpId(ctx.tenantId, unit.opId)) !== "unknown";
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const r = await deps.pullPage(deviceId, isOwn);
    if (r.deviceTrust) {
      await deps.store.setError(r.deviceTrust.message);
      state = (await deps.store.get())!;
      return result(r.deviceTrust.message);
    }
    await deps.store.addProgress(r.pulled, r.acknowledged ?? 0);
    if (r.failed > 0) {
      // A unit is waiting for a dependency: the cursor is held; finish on a later run.
      state = (await deps.store.get())!;
      return result();
    }
    if (r.pulled === 0) {
      await deps.store.markDone();
      state = (await deps.store.get())!;
      return result();
    }
  }
  state = (await deps.store.get())!;
  return result();
}

async function firstKnownDevice(devices: ISyncDeviceRepository, tenantId: string, ids: string[]) {
  for (const id of ids) {
    const row = await devices.findById(tenantId, id);
    if (row) return row;
  }
  return null;
}
