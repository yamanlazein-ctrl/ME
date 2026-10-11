/**
 * Primary-archive-device enforcement (fail-closed).
 *
 * The designation lives in the `drive` settings section — company data that
 * replicates through the hub like every other settings section — so two
 * devices can never independently become primary. The upload worker refuses
 * to run unless the local device IS the designated coordinator: when the
 * setting is absent/ambiguous, nothing uploads.
 */
import { eq } from "drizzle-orm";
import { settings } from "../orm/sqlite/schemas/setting.table.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

export type DriveSettings = {
  /** Device id of the designated primary archive device. */
  coordinatorDeviceId?: string | null;
  /** Marked by the owner in the settings screen; required before auto-upload. */
  archiveEnabled?: boolean;
};

export async function readDriveSettings(db: DB): Promise<DriveSettings> {
  const [row] = await db.select({ drive: settings.drive }).from(settings).limit(1);
  return (row?.drive as DriveSettings | null) ?? {};
}

/** Write the drive section (merges); callers enqueue the settings sync unit via the normal route. */
export async function writeDriveSettings(db: DB, patch: DriveSettings, tenantId: string): Promise<DriveSettings> {
  const current = await readDriveSettings(db);
  const next = { ...current, ...patch };
  await db
    .update(settings)
    .set({ drive: next, updatedAt: new Date() })
    .where(eq(settings.tenantId, tenantId));
  return next;
}

export type CoordinatorDecision =
  | { allowed: true }
  | { allowed: false; reason: "NOT_ENABLED" | "NO_COORDINATOR" | "NOT_COORDINATOR" };

/**
 * The worker's authorization gate. Fail-closed: any ambiguity → no upload.
 */
export async function authorizeUploadDevice(db: DB, localDeviceId: string): Promise<CoordinatorDecision> {
  const s = await readDriveSettings(db);
  if (!s.archiveEnabled) return { allowed: false, reason: "NOT_ENABLED" };
  if (!s.coordinatorDeviceId) return { allowed: false, reason: "NO_COORDINATOR" };
  if (s.coordinatorDeviceId !== localDeviceId) return { allowed: false, reason: "NOT_COORDINATOR" };
  return { allowed: true };
}
