/**
 * Restore on a device that already synchronized with a hub (T109; OQ-12, SY-6, SY-7; owner
 * decision 2026-10-05: option b — the restored device takes a new sync identity).
 *
 * The state is written by the restore itself and advanced by the sync run:
 *   register — sync is paused; the device must register a new sync device id on the hub;
 *   pull     — still paused for pushes; pulling under the new identity until the hub has nothing
 *              newer (own post-backup work comes back; already-held op-ids are acknowledged);
 *   done     — normal sync resumes under the new identity (kept for every later run).
 */
export type SyncRestorePhase = "register" | "pull" | "done";

export interface SyncRestoreState {
  restoredAt: string;
  generation: number;
  /** Sync device ids this database used before the restore (the outbox's attributions). */
  previousDeviceIds: string[];
  /** The identity registered on the hub after the restore (null until `register` succeeds). */
  newDeviceId: string | null;
  phase: SyncRestorePhase;
  /** Units pulled since the restore. */
  pulled: number;
  /** Restored outbox units acknowledged because the hub already held their op-id. */
  acknowledged: number;
  lastError: string | null;
}

export interface ISyncRestoreStateStore {
  get(): Promise<SyncRestoreState | null>;
  /** register → pull, with the identity now registered on the hub (and locally). */
  setRegistered(newDeviceId: string): Promise<void>;
  addProgress(pulled: number, acknowledged: number): Promise<void>;
  setError(message: string | null): Promise<void>;
  /** pull → done: normal sync resumes. */
  markDone(): Promise<void>;
}
