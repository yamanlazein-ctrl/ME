/**
 * Restore on a synced device (T109, option b): after a restore the database runs under a NEW sync
 * identity. A client that still asserts a previous identity (a UI that has not synced since the
 * restore, an old tab) is mapped to the new one, so document numbering, outbox attribution and hub
 * exchanges never act for an identity whose number blocks and hub seat were superseded.
 *
 * PostgreSQL never restores a device snapshot: the mapping is the identity. The SQLite state is read
 * once and cached; any write to the restore state, and every restore, invalidates the cache.
 */
import { getEngine } from "../orm/engine.js";

type Mapping = { previous: Set<string>; current: string } | null;
let cached: Promise<Mapping> | null = null;

export function invalidateRestoredIdentity(): void {
  cached = null;
}

async function load(): Promise<Mapping> {
  const { getSyncRestoreStateStore } = await import("../repositories/engineStores.js");
  const state = await (await getSyncRestoreStateStore()).get();
  if (!state?.newDeviceId) return null;
  return { previous: new Set(state.previousDeviceIds.map((id) => id.toLowerCase())), current: state.newDeviceId };
}

export async function mapRestoredSyncDeviceId(id: string | null): Promise<string | null> {
  if (!id || getEngine() !== "sqlite") return id;
  cached ??= load().catch(() => null);
  const m = await cached;
  return m && m.previous.has(id.toLowerCase()) ? m.current : id;
}
