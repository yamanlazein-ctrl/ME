/**
 * Raw persistence used by sync materialization (specs/001-desktop-sqlite-engine S1).
 *
 * NOTE (research I-2): the PostgreSQL store runs on the shared pool — each call
 * commits on its own connection, independent of the caller's transaction (a
 * tombstone survives a rolled-back materialization). The SQLite store must
 * reproduce that commit semantics.
 */
export interface SyncUserSnapshotRow {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  passwordHash: string;
  pinHash: string | null;
  role: string;
  active: boolean;
  updatedAt: string;
}

export interface ISyncMaterializeStore {
  tombstoneExists(tenantId: string, entityType: string, entityId: string): Promise<boolean>;
  recordTombstone(tenantId: string, entityType: string, entityId: string, opId: string, deletedByDeviceId: string | null): Promise<void>;
  /** Upsert a synced user snapshot; newer local rows (`updated_at` greater) are kept. */
  upsertUserSnapshot(u: SyncUserSnapshotRow): Promise<void>;
}
