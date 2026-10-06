/**
 * Process-level crash guards for the bundled Desktop server.
 *
 * Why this exists
 * ---------------
 * On the desktop build the Node server is not "a web server" the user can
 * restart — it IS the app. The Rust shell supervises one child process, and the
 * WebView2 window can only show a local origin. If Node dies for ANY reason the
 * user stares at WebView2's built-in "no internet / can't reach this page"
 * screen, which is both wrong (the machine may be perfectly online) and
 * unactionable.
 *
 * Most of the ways this used to happen are ordinary runtime faults, not fatal
 * ones:
 *   - a stray `throw` in a timer / stream / fs callback (an unhandled
 *     'error' event on a stream is an uncaught exception),
 *   - a promise nobody awaited rejecting,
 *   - a single malformed request tripping a shared code path.
 * None of those justify taking the whole application down mid-session.
 *
 * So the guard downgrades them to log lines and keeps serving.
 *
 * What the guard deliberately does NOT swallow
 * ---------------------------------------------
 * A start-up refusal stays fatal. `process.exit(1)` is never intercepted (see
 * `server.ts`: migrations failing, and the http server's own bind 'error'
 * event both exit explicitly and write `[FATAL] …` to stderr first), and the
 * crash counter below gives up after a bounded number of faults so a genuinely
 * broken process is recycled cleanly by the shell instead of limping forever.
 */

import { logger } from "./logger.js";

/**
 * Uncaught faults tolerated before the process deliberately gives up and lets
 * the desktop shell restart it from a clean state. 10 is far above any healthy
 * session (these are *uncaught* — every handled error never lands here) and far
 * below "the user watches a half-dead app for an hour".
 */
export const MAX_TOLERATED_CRASHES = 10;

/** Shape of the guard, exported so tests and the shell-facing log agree on it. */
export interface ProcessGuard {
  /** Faults seen so far in this process. */
  readonly crashes: number;
  /** True once `crashes` reached the tolerance and the process has given up. */
  readonly givenUp: boolean;
}

type GuardState = { crashes: number; givenUp: boolean; fatalUntilServing: boolean; serving: boolean };

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Install the guards. Idempotent — calling twice does not double-count faults.
 *
 * Returns the live guard state so the caller (and tests) can assert on it.
 */
export function installProcessGuards(opts: { fatalUntilServing?: boolean } = {}): ProcessGuard {
  const g = globalThis as typeof globalThis & { __motardProcessGuard?: GuardState };
  if (g.__motardProcessGuard) return g.__motardProcessGuard;

  const state: GuardState = {
    crashes: 0,
    givenUp: false,
    fatalUntilServing: opts.fatalUntilServing ?? false,
    serving: false,
  };
  g.__motardProcessGuard = state;

  const onFault = (kind: "exception" | "rejection", err: unknown) => {
    // Before the server is serving there is nothing to keep alive: a fault while
    // the process is still being built (e.g. a throw in the container) would
    // otherwise leave a process with no listener at all — alive, silent, never
    // reachable. That is a start-up refusal, and start-up refusals are fatal.
    if (state.fatalUntilServing && !state.serving) {
      process.stderr.write(`[FATAL] Server startup failed (uncaught ${kind}): ${describe(err)}
`);
      process.exit(1);
    }
    // `exit` is a hard decision made by the call sites that own their failure
    // mode (migrations, bind errors). Never re-derive it here.
    state.crashes += 1;
    const last = state.crashes >= MAX_TOLERATED_CRASHES;
    if (last) state.givenUp = true;

    logger.error(
      { err, kind, crashes: state.crashes, tolerated: !last },
      last
        ? `UNCAUGHT_${kind.toUpperCase()}_BUDGET_EXHAUSTED — exiting for a clean restart`
        : `UNCAUGHT_${kind.toUpperCase()} — contained, server keeps serving`,
    );
    // The structured log travels through pino's worker thread and can be lost
    // the instant the process ends. The desktop shell only reads server.log,
    // so mirror the fault there synchronously — and the give-up is the one
    // line support needs most, because it is the reason the shell restarted.
    process.stderr.write(
      last
        ? `[FATAL] Uncaught ${kind} budget exhausted after ${state.crashes} faults — exiting for a clean restart: ${describe(err)}\n`
        : `[FATAL] Uncaught ${kind}: ${describe(err)}\n`,
    );

    if (last) process.exit(1);
  };

  process.on("uncaughtException", (err) => onFault("exception", err));
  process.on("unhandledRejection", (reason) => onFault("rejection", reason));

  logger.info(
    { maxToleratedCrashes: MAX_TOLERATED_CRASHES },
    "PROCESS_GUARDS_INSTALLED",
  );
  return state;
}

/** The server is listening: from now on faults are contained (see `fatalUntilServing`). */
export function markServing(): void {
  const g = globalThis as typeof globalThis & { __motardProcessGuard?: GuardState };
  if (g.__motardProcessGuard) g.__motardProcessGuard.serving = true;
}
