/** Sync pull-cursor + party-opening reads used by syncUseCases (specs/001-desktop-sqlite-engine S1). */
export interface ISyncStateStore {
  /** Opening balance (as a JS number) and the date of its 'opening' ledger row, if any. */
  partyOpening(tenantId: string, partyId: string): Promise<{ amount: number | null; date: string | null } | undefined>;
  resetPullCursor(tenantId: string): Promise<void>;
  getPullCursor(tenantId: string): Promise<{ lastPullSeq: number | null; lastPullAt: Date | null }>;
  /** Monotonic: only advances (never moves the cursor backwards). */
  setPullCursor(tenantId: string, seq: number, at: Date | null): Promise<void>;
}
