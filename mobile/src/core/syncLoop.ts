// The sync schedule (FR-32): a run on start, when the app returns to the foreground, when the network comes back, 2 s after
// the last write, and every 20 s while in the foreground. After a failed run the retries come at 30 s and 120 s. The loop
// only decides WHEN to run; one run is `runPhoneSyncCycle` (the shared sync client). Hub answers that stop sync arrive as
// signals from the hub fetch wrapper (hubHttp.ts): a version mismatch halts the loop (E9), a revoked device halts it and
// reports `revoked` (FR-40), and a hub clock more than 5 minutes off the phone's is reported once per run (E16).
import type { HubSignal } from "./hubHttp";
import type { SyncCycleResult } from "./syncCycle";

export const FOREGROUND_INTERVAL_MS = 20_000;
export const WRITE_DEBOUNCE_MS = 2_000;
export const RETRY_DELAYS_MS = [30_000, 120_000] as const;
export const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

export type SyncLoopEvent =
  | { type: "cycle"; result: SyncCycleResult }
  | { type: "error"; message: string }
  | { type: "versionMismatch" }
  | { type: "revoked" }
  | { type: "unknownDevice" }
  | { type: "clockSkew"; skewMs: number };

export interface SyncLoopDeps {
  run(): Promise<SyncCycleResult>;
  emit(event: SyncLoopEvent): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface SyncLoop {
  start(): void;
  stop(): void;
  /** App state changed to active. */
  onForeground(): void;
  /** App state changed to inactive/background. */
  onBackground(): void;
  onNetworkRegain(): void;
  /** A local write was committed. */
  notifyWrite(): void;
  /** Feed hub-fetch signals here. */
  signal(signal: HubSignal): void;
  readonly halted: "versionMismatch" | "revoked" | "unknownDevice" | null;
}

function failed(result: SyncCycleResult): boolean {
  return Boolean(result.pullError) || result.push.failed > 0;
}

export function createSyncLoop(deps: SyncLoopDeps): SyncLoop {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let started = false;
  let foreground = true;
  let running = false;
  let rerun = false;
  let halted: SyncLoop["halted"] = null;
  let retryIndex = 0;
  let intervalHandle: unknown = null;
  let debounceHandle: unknown = null;
  let retryHandle: unknown = null;
  let skewReported = false;
  let serverSkewMs: number | null = null;

  const clearAll = () => {
    for (const h of [intervalHandle, debounceHandle, retryHandle]) if (h !== null) clearTimer(h);
    intervalHandle = debounceHandle = retryHandle = null;
  };

  const scheduleInterval = () => {
    if (intervalHandle !== null) clearTimer(intervalHandle);
    intervalHandle = null;
    if (!started || !foreground || halted) return;
    intervalHandle = setTimer(() => {
      intervalHandle = null;
      void runNow();
    }, FOREGROUND_INTERVAL_MS);
  };

  async function runNow(): Promise<void> {
    if (!started || halted) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    skewReported = false;
    let ok = false;
    try {
      const result = await deps.run();
      ok = !failed(result);
      deps.emit({ type: "cycle", result });
      if (result.push.deviceGate && result.push.deviceTrust?.code === "SYNC_DEVICE_REVOKED") {
        signalHalt("revoked");
      }
    } catch (error) {
      deps.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
    if (serverSkewMs !== null && Math.abs(serverSkewMs) > CLOCK_SKEW_LIMIT_MS && !skewReported) {
      skewReported = true;
      deps.emit({ type: "clockSkew", skewMs: serverSkewMs });
    }
    if (halted) return;
    if (ok) {
      retryIndex = 0;
      if (retryHandle !== null) clearTimer(retryHandle);
      retryHandle = null;
    } else if (retryHandle === null) {
      if (intervalHandle !== null) clearTimer(intervalHandle);
      intervalHandle = null;
      const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] as number;
      retryIndex += 1;
      retryHandle = setTimer(() => {
        retryHandle = null;
        void runNow();
      }, delay);
    }
    if (rerun) {
      rerun = false;
      void runNow();
    } else if (ok) {
      scheduleInterval(); // after a failure only the 30 s / 120 s retries run
    }
  }

  function signalHalt(kind: NonNullable<SyncLoop["halted"]>) {
    if (halted) return;
    halted = kind;
    clearAll();
    deps.emit({ type: kind });
  }

  return {
    get halted() {
      return halted;
    },
    start() {
      if (started) return;
      started = true;
      void runNow();
    },
    stop() {
      started = false;
      clearAll();
    },
    onForeground() {
      foreground = true;
      if (started) void runNow();
    },
    onBackground() {
      foreground = false;
      if (intervalHandle !== null) clearTimer(intervalHandle);
      intervalHandle = null;
    },
    onNetworkRegain() {
      if (started) void runNow();
    },
    notifyWrite() {
      if (!started || halted) return;
      if (debounceHandle !== null) clearTimer(debounceHandle);
      debounceHandle = setTimer(() => {
        debounceHandle = null;
        void runNow();
      }, WRITE_DEBOUNCE_MS);
    },
    signal(signal) {
      if (signal.kind === "versionMismatch") signalHalt("versionMismatch");
      else if (signal.kind === "revoked") signalHalt("revoked");
      else if (signal.kind === "unknownDevice") deps.emit({ type: "unknownDevice" });
      else if (signal.kind === "serverDate") serverSkewMs = signal.date.getTime() - now();
    },
  };
}
