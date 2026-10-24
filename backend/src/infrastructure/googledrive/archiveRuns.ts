/**
 * Phase 4 — archive run state and progress.
 *
 * A run is one archive pass (monthly, catch-up, manual or connect). Progress is kept in the run's `detail`
 * column as JSON, so the existing `motard_drive_runs` table carries it without a schema change.
 *
 * The state machine is pure: it validates transitions and computes progress. Persistence is the caller's
 * job (`persistRunState`), which keeps this module testable without a database.
 */

export type RunState = "running" | "done" | "failed" | "partial" | "cancelled";
export type RunTrigger = "monthly" | "catchup" | "manual" | "connect";

export type RunProgress = {
  trigger: RunTrigger;
  periodKey: string;
  done: number;
  total: number;
  currentFile: string | null;
  errors: string[];
  cancelRequested: boolean;
};

const TERMINAL: RunState[] = ["done", "failed", "partial", "cancelled"];

export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state);
}

/** A new run starts at zero progress. The total is set once the work list is known. */
export function newRunProgress(trigger: RunTrigger, periodKey: string): RunProgress {
  return {
    trigger,
    periodKey,
    done: 0,
    total: 0,
    currentFile: null,
    errors: [],
    cancelRequested: false,
  };
}

/** Set the number of files this run will process. */
export function setTotal(p: RunProgress, total: number): RunProgress {
  if (!Number.isInteger(total) || total < 0) throw new Error("RUN_TOTAL_INVALID");
  return { ...p, total, done: Math.min(p.done, total) };
}

/** One file finished (uploaded, or skipped as unchanged). Never moves past the total. */
export function advance(p: RunProgress, fileName: string): RunProgress {
  return { ...p, done: Math.min(p.total, p.done + 1), currentFile: fileName };
}

/** A file failed; the run keeps going and records the error. */
export function recordError(p: RunProgress, fileName: string, message: string): RunProgress {
  return {
    ...p,
    done: Math.min(p.total, p.done + 1),
    currentFile: fileName,
    errors: [...p.errors, `${fileName}: ${message}`.slice(0, 300)].slice(-50),
  };
}

/** The state a finished run ends in: all good → done; some failed → partial; everything failed → failed. */
export function finalState(p: RunProgress, attempted: number): RunState {
  if (p.cancelRequested) return "cancelled";
  if (attempted === 0) return "done";
  const failed = p.errors.length;
  if (failed === 0) return "done";
  if (failed >= attempted) return "failed";
  return "partial";
}

/** Request cancellation. Only a running run can be cancelled; the worker checks the flag between files. */
export function requestCancel(p: RunProgress, state: RunState): RunProgress {
  if (isTerminal(state)) throw new Error("RUN_NOT_RUNNING");
  return { ...p, cancelRequested: true };
}

/** Percent complete for the UI (0–100). An empty run is 100. */
export function percent(p: RunProgress): number {
  if (p.total === 0) return 100;
  return Math.round((p.done / p.total) * 100);
}

/**
 * The live runs of this process, keyed by run id. The pass writes progress here as it works, and the
 * progress route reads it. A finished run stays until it is pruned, so a late poll still gets its result.
 */
const live = new Map<string, { state: RunState; progress: RunProgress; updatedAt: number }>();
const MAX_KEPT = 20;

export function startLiveRun(runId: string, progress: RunProgress): void {
  live.set(runId, { state: "running", progress, updatedAt: Date.now() });
  pruneLive();
}

/**
 * Update the published progress.
 *
 * The cancel flag is MONOTONIC: a cancel the user requested is never cleared by a later write. The
 * worker keeps its OWN local copy of the progress and that copy knows nothing about a cancel that
 * arrived out of band (the cancel route only touches the live map), so without this merge the very
 * next finished file overwrote `cancelRequested` with `false` and the run carried on to 'done' —
 * the cancel was silently dropped (remediation B-01).
 *
 * Returns the merged progress so the caller can keep its local copy in step with the live one.
 */
export function updateLiveRun(runId: string, progress: RunProgress): RunProgress {
  const cur = live.get(runId);
  const merged: RunProgress = cur
    ? { ...progress, cancelRequested: cur.progress.cancelRequested || progress.cancelRequested }
    : progress;
  if (cur) live.set(runId, { ...cur, progress: merged, updatedAt: Date.now() });
  return merged;
}

export function finishLiveRun(runId: string, state: RunState, progress: RunProgress): void {
  const cur = live.get(runId);
  if (cur) live.set(runId, { state, progress, updatedAt: Date.now() });
}

export function getLiveRun(runId: string): { state: RunState; progress: RunProgress } | null {
  const cur = live.get(runId);
  return cur ? { state: cur.state, progress: cur.progress } : null;
}

/**
 * The id of the run that is currently in progress, if there is one. The UI needs it to show the
 * progress bar and to offer "cancel" without having to keep the id from the response that started
 * the run (a run started by the timer or by a reconnect has no such response).
 */
export function currentLiveRunId(): string | null {
  let newest: { id: string; updatedAt: number } | null = null;
  for (const [id, v] of live) {
    if (isTerminal(v.state)) continue;
    if (!newest || v.updatedAt > newest.updatedAt) newest = { id, updatedAt: v.updatedAt };
  }
  return newest?.id ?? null;
}

/** Ask a running run to stop. Returns false when the run is unknown or already finished. */
export function cancelLiveRun(runId: string): boolean {
  const cur = live.get(runId);
  if (!cur || isTerminal(cur.state)) return false;
  live.set(runId, { ...cur, progress: requestCancel(cur.progress, cur.state) });
  return true;
}

function pruneLive(): void {
  if (live.size <= MAX_KEPT) return;
  const finished = [...live.entries()]
    .filter(([, v]) => isTerminal(v.state))
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [id] of finished.slice(0, live.size - MAX_KEPT)) live.delete(id);
}

/** Store progress as the run's `detail` JSON, and read it back defensively. */
export function encodeDetail(p: RunProgress): string {
  return JSON.stringify(p);
}

export function decodeDetail(
  detail: string | null | undefined,
  fallback: RunProgress,
): RunProgress {
  if (!detail) return fallback;
  try {
    const v = JSON.parse(detail) as Partial<RunProgress>;
    return {
      trigger: v.trigger ?? fallback.trigger,
      periodKey: v.periodKey ?? fallback.periodKey,
      done: Number.isInteger(v.done) ? (v.done as number) : 0,
      total: Number.isInteger(v.total) ? (v.total as number) : 0,
      currentFile: typeof v.currentFile === "string" ? v.currentFile : null,
      errors: Array.isArray(v.errors)
        ? v.errors.filter((e): e is string => typeof e === "string")
        : [],
      cancelRequested: v.cancelRequested === true,
    };
  } catch {
    return fallback;
  }
}
