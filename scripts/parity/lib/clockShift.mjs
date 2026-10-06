/**
 * Test-only clock shift for the long-offline test (T104). Preloaded into a backend process with
 *   NODE_OPTIONS=--import=<file URL of this module>   MOTARD_CLOCK_SHIFT_FILE=<path>
 * `Date.now()` and `new Date()` (no arguments) return the real time plus the number of milliseconds
 * stored in the file, re-read every 100 ms, so a running server can be moved days ahead. Every
 * application clock (document dates, the SQLite transaction clock, token checks) reads `Date`.
 * Explicit dates (`new Date(x)`, `Date.parse`) are untouched.
 */
import { readFileSync } from "node:fs";

const file = process.env.MOTARD_CLOCK_SHIFT_FILE;
if (file) {
  let offset = 0;
  const read = () => {
    try {
      offset = Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {
      /* keep the last value */
    }
  };
  read();
  setInterval(read, 100).unref();
  const RealDate = Date;
  const now = () => RealDate.now() + offset;
  // A Proxy (not a subclass): `Date()` without `new` keeps working, and `x instanceof Date` still
  // checks the real prototype, so every Date stays a plain Date.
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => (args.length === 0 ? new target(now()) : new target(...args)),
    apply: () => new RealDate(now()).toString(),
    get: (target, prop, receiver) => (prop === "now" ? now : Reflect.get(target, prop, receiver)),
  });
}
