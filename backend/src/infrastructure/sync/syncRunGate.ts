/**
 * In-process sync run lock (SQLite desktop: one process) shared by the sync cycle and by the
 * database restore (DESK-031).
 *
 * A sync cycle holds its tenant's run key for the whole run, network waits included. A restore
 * swaps the database file between two SQL statements of such a run if nothing stops it, and the
 * cycle then acknowledges/applies against a database it never read. `withSyncPaused` refuses new
 * cycles, waits for the running ones to finish, and only then runs the swap.
 */
const held = new Set<string>();
let paused = 0;
const idle: Array<() => void> = [];

/** Start a run for `key` (tenant). False while another run holds it or a restore has paused sync. */
export function tryAcquireSyncRun(key: string): boolean {
  if (paused > 0 || held.has(key)) return false;
  held.add(key);
  return true;
}

export function releaseSyncRun(key: string): void {
  held.delete(key);
  if (held.size === 0) idle.splice(0).forEach((wake) => wake());
}

export function isSyncPaused(): boolean {
  return paused > 0;
}

/** Run `fn` with no sync cycle in flight and none allowed to start until it ends. */
export async function withSyncPaused<T>(fn: () => Promise<T>): Promise<T> {
  paused += 1;
  try {
    while (held.size > 0) await new Promise<void>((resolve) => idle.push(resolve));
    return await fn();
  } finally {
    paused -= 1;
  }
}
