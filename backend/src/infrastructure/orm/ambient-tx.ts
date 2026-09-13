import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient (context-local) transaction handle — the mechanism that lets an
 * existing repository keep calling `this.db.*` while actually executing on the
 * transaction opened by an OUTER caller.
 *
 * Why this exists (F-07): the sync outbox enqueue used to run AFTER the business
 * use-case had already committed, on a separate pooled connection, inside a
 * `try/catch { logger.warn }`. A failure left the document durably saved
 * locally with NO outbox row — a silent divergence that could never be
 * repaired, because nothing re-scans business tables to find un-enqueued writes.
 *
 * The fix is the Transactional Outbox pattern with a single transaction
 * boundary: the route opens ONE `withTenantTx`, the business write and the
 * outbox insert both run inside it, and either both commit or both roll back.
 *
 * Rather than thread a `tx` parameter through 15 repositories, 9 ports and 15
 * use-cases (large blast radius, and it would push sync concerns into the
 * repositories), the transaction is published into AsyncLocalStorage for the
 * duration of the callback. `ambientDb()` returns a Proxy around the ordinary
 * pool-backed `db` that transparently forwards every property access to the
 * ambient transaction when one is active.
 *
 * Nesting semantics are Drizzle's: `tx.transaction(cb)` inside an active
 * ambient transaction issues a SAVEPOINT on the SAME connection, so an inner
 * repository failure rolls back only its own savepoint while the outer
 * transaction stays usable — that is what keeps the existing repository-level
 * `db.transaction(...)` boundaries intact and correct.
 *
 * Scope discipline: this module is intentionally generic (it does not import
 * `drizzle.ts`) so `drizzle.ts` can import it without a circular dependency.
 */

interface AmbientTxStore {
  tx: unknown;
  /**
   * Tenant the ambient transaction was opened for. Used to REFUSE a nested
   * `withTenantTx` for a different tenant: joining another tenant's
   * transaction would run the caller's statements under the wrong RLS GUC
   * (the write would be rejected by the policy, but only after the caller has
   * already lost its own atomic boundary — a loud, explicit error is safer).
   */
  tenantId: string;
}

const storage = new AsyncLocalStorage<AmbientTxStore>();

/** True when the current async context is inside a `withTenantTx`. */
export function hasAmbientTx(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * The active ambient transaction handle, or `null` when none is published.
 * `withTenantTx` uses this to JOIN an outer transaction instead of checking
 * out a second pooled connection (which would commit independently).
 */
export function getAmbientTx<Tx = unknown>(): Tx | null {
  const store = storage.getStore();
  return store ? (store.tx as Tx) : null;
}

/** Tenant id of the active ambient transaction, or `null` when none. */
export function getAmbientTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

/**
 * Run `fn` with `tx` published as the ambient transaction. Every `ambientDb()`
 * proxy accessed inside `fn` (and anything `fn` awaits) will execute on `tx`.
 */
export function runInAmbientTx<Tx, T>(tx: Tx, tenantId: string, fn: () => T): T {
  return storage.run({ tx, tenantId }, fn);
}

/**
 * Wrap a pool-backed Drizzle instance so it transparently rebinds to the
 * ambient transaction when one is active.
 *
 * When no transaction is active the proxy is a pass-through to `base`, so
 * outside callers (scripts, tests, non-sync request paths) are unaffected.
 *
 * Functions are bound to their owner object so `this.db.select()` resolves
 * `this.session` on the correct instance rather than on the proxy.
 */
export function ambientDb<D extends object>(base: D): D {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const store = storage.getStore();
      if (store) {
        const value = Reflect.get(store.tx as object, prop);
        return typeof value === "function" ? value.bind(store.tx) : value;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D;
}
