// SQLite-only (no PG twin): restore-on-synced-device state, table motard_sync_restore
// (migration 0002_sync_restore_state; written by sqliteRestore.ts, advanced by the sync run).
import { sql } from "drizzle-orm";
import { runAutonomous } from "../../orm/sqlite/transaction.js";
import { invalidateRestoredIdentity } from "../../sync/restoredIdentity.js";
import type { ISyncRestoreStateStore, SyncRestorePhase, SyncRestoreState } from "../../../application/ports/ISyncRestoreStateStore.js";

const nowText = () => new Date().toISOString().replace("Z", "000Z");

function rowsOf(r: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, unknown>>;
}

export class SqliteSyncRestoreStateStore implements ISyncRestoreStateStore {
  async get(): Promise<SyncRestoreState | null> {
    return runAutonomous(async (tx) => {
      const [row] = rowsOf(await tx.execute(sql`SELECT * FROM motard_sync_restore WHERE id = 1`));
      if (!row) return null;
      return {
        restoredAt: String(row.restored_at),
        generation: Number(row.generation),
        previousDeviceIds: JSON.parse(String(row.previous_device_ids)) as string[],
        newDeviceId: row.new_device_id == null ? null : String(row.new_device_id),
        phase: String(row.phase) as SyncRestorePhase,
        pulled: Number(row.pulled),
        acknowledged: Number(row.acknowledged),
        lastError: row.last_error == null ? null : String(row.last_error),
      };
    });
  }

  async setRegistered(newDeviceId: string): Promise<void> {
    await runAutonomous(async (tx) => {
      await tx.execute(sql`UPDATE motard_sync_restore SET new_device_id = ${newDeviceId}, phase = 'pull', last_error = NULL,
        updated_at = ${nowText()} WHERE id = 1 AND phase = 'register'`);
    });
    invalidateRestoredIdentity();
  }

  async addProgress(pulled: number, acknowledged: number): Promise<void> {
    if (!pulled && !acknowledged) return;
    await runAutonomous(async (tx) => {
      await tx.execute(sql`UPDATE motard_sync_restore SET pulled = pulled + ${pulled}, acknowledged = acknowledged + ${acknowledged},
        updated_at = ${nowText()} WHERE id = 1`);
    });
  }

  async setError(message: string | null): Promise<void> {
    await runAutonomous(async (tx) => {
      await tx.execute(sql`UPDATE motard_sync_restore SET last_error = ${message}, updated_at = ${nowText()} WHERE id = 1`);
    });
  }

  async markDone(): Promise<void> {
    await runAutonomous(async (tx) => {
      await tx.execute(sql`UPDATE motard_sync_restore SET phase = 'done', last_error = NULL, updated_at = ${nowText()}
        WHERE id = 1 AND phase = 'pull'`);
    });
  }
}
