/**
 * Raw persistence for `sync_conflicts` (specs/001-desktop-sqlite-engine S1).
 * Rows are returned in database column naming; mapping, tenant-context checks
 * and error policy stay in application/use-cases/sync/syncConflicts.ts.
 *
 * NOTE (research I-2): the PostgreSQL store runs on the shared pool, i.e. each
 * call commits on its own connection, independent of any caller transaction.
 */
export type SyncConflictDbRow = Record<string, unknown>;

export interface ISyncConflictStore {
  insertOpen(input: {
    tenantId: string;
    opId: string;
    entityType: string;
    entityId: string;
    operation: string;
    baseVersion: number | null;
    serverVersion: number | null;
    localIntentJson: string;
  }): Promise<number>;
  list(tenantId: string, openOnly: boolean, limit: number): Promise<SyncConflictDbRow[]>;
  resolve(tenantId: string, conflictId: string, decision: string, byUserId: string | null, note: string | null): Promise<SyncConflictDbRow | null>;
  resolveByOp(tenantId: string, opId: string, reason: string): Promise<void>;
}
