/**
 * Memoize a promise-returning factory, but ONLY while it stays fulfilled.
 *
 * F03 (Phase 1 foundation audit): server.ts used to memoize a dynamic
 * import() in a plain `let cached: Promise<T> | undefined` with an
 * `if (!cached)` guard. A Promise object is truthy even after it rejects,
 * so that guard only ever protected the FIRST call — once a transient
 * import failure (a known Vite dev-server module-runner race) rejected the
 * cached promise, every subsequent call reused that same dead promise
 * forever, with no retry short of a process restart.
 *
 * This wraps that pattern once, correctly: a rejection clears the cache so
 * the NEXT call gets a fresh attempt, while a successful result stays
 * memoized (the whole point of caching an expensive one-time import).
 */
export function memoizeUntilRejected<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) {
      cached = factory().catch((err: unknown) => {
        cached = undefined;
        throw err;
      });
    }
    return cached;
  };
}
