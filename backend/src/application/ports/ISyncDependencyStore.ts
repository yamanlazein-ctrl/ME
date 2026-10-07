/**
 * Persistence for sync dependency replay (syncDependencySnapshots), per engine
 * (specs/001-desktop-sqlite-engine S1). Each method runs on the caller-provided
 * executor (a db for applyPartyOpening, an open transaction for ensure…InTx).
 */
import type { InvoiceSyncDependencies, SyncPartySnapshot } from "../use-cases/sync/syncDependencySnapshots.js";
import type { TenantContext } from "../../domain/types/index.js";

export type ReplayPartySnapshot = SyncPartySnapshot;
export type ReplayDependencies = InvoiceSyncDependencies;

/** Application rules the dependency replay needs, injected so infrastructure never imports them. */
export interface DependencyReplayHooks {
  /** True when a tombstone guards (tenant, type, id) — never resurrect a deleted master. */
  tombstoneBlocks(tenantId: string, entityType: string, entityId: string): Promise<boolean>;
  /** Deterministic code/name/roll-number collision resolution (mutates the snapshot). */
  resolveMaster(executor: unknown, kind: "party" | "roll" | "fabric" | "color", snap: Record<string, unknown>, tenantId: string): Promise<void>;
}

export interface ISyncDependencyStore {
  /** Opening journal + parties.opening_balance, once (idempotent on the 'opening' ledger row). */
  applyPartyOpening(executor: unknown, snap: ReplayPartySnapshot, ctx: TenantContext, amount: number, date: string): Promise<void>;
  /** Insert-if-missing for every dependency master (parties, fabrics, colors, rolls). */
  ensureDependenciesInTx(executor: unknown, deps: ReplayDependencies, ctx: TenantContext, hooks: DependencyReplayHooks): Promise<void>;
}
