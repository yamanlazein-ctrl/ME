import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncLoop, type SyncLoopEvent } from "../../src/core/syncLoop";
import type { SyncCycleResult } from "../../src/core/syncCycle";

const ok = (): SyncCycleResult => ({
  push: {
    pushed: 0,
    failed: 0,
    rejected: 0,
    hubDead: 0,
    hubDeadOps: [],
    deviceGate: false,
    deviceTrust: null,
    skipped: false,
  },
  pull: { pulled: 0, applied: 0, skipped: 0, failed: 0, deviceTrust: null },
  pullError: null,
  blocksError: null,
  skipped: false,
});
const bad = (): SyncCycleResult => ({ ...ok(), pullError: "offline" });

let runs: number;
let events: SyncLoopEvent[];
const make = (results: Array<() => SyncCycleResult | Promise<never>>) => {
  const queue = [...results];
  const loop = createSyncLoop({
    run: async () => {
      runs += 1;
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return next();
    },
    emit: (e) => events.push(e),
  });
  return loop;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T10:00:00Z"));
  runs = 0;
  events = [];
});
afterEach(() => vi.useRealTimers());

describe("syncLoop schedule (FR-32)", () => {
  it("runs on start, then every 20 s while in the foreground, and stops in the background", async () => {
    const loop = make([ok]);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(3);
    loop.onBackground();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(3);
    loop.onForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(4);
    loop.stop();
  });

  it("runs on network regain and 2 s after the last write (debounced)", async () => {
    const loop = make([ok]);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.onNetworkRegain();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    loop.notifyWrite();
    await vi.advanceTimersByTimeAsync(1_500);
    loop.notifyWrite(); // restarts the 2 s
    await vi.advanceTimersByTimeAsync(1_500);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toBe(3);
    loop.stop();
  });

  it("after a failed run only the retries run: at 30 s, then at 120 s, then back to 20 s once it succeeds", async () => {
    const loop = make([bad, bad, ok]);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(2); // retry 1 at 30 s (fails again)
    await vi.advanceTimersByTimeAsync(119_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toBe(3); // retry 2 at 120 s (succeeds)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(4); // the 20 s interval is back
    loop.stop();
  });

  it("never runs two cycles at once; a request during a run reruns once afterwards", async () => {
    let release!: () => void;
    let calls = 0;
    const loop = createSyncLoop({
      run: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return ok();
      },
      emit: () => undefined,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.onNetworkRegain();
    loop.onNetworkRegain();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    loop.stop();
  });

  it("halts and emits on versionMismatch and revoked; reports unknownDevice without halting", async () => {
    const a = make([ok]);
    a.start();
    await vi.advanceTimersByTimeAsync(0);
    a.signal({ kind: "unknownDevice", error: new Error("x") as never });
    expect(a.halted).toBeNull();
    a.signal({ kind: "versionMismatch", error: new Error("x") as never });
    expect(a.halted).toBe("versionMismatch");
    const before = runs;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(before);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["unknownDevice", "versionMismatch"]),
    );

    events = [];
    const b = make([ok]);
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    b.signal({ kind: "revoked", error: new Error("x") as never });
    expect(b.halted).toBe("revoked");
    expect(events.at(-1)?.type).toBe("revoked");
  });

  it("emits clockSkew when the hub Date differs from the phone clock by more than 5 minutes", async () => {
    const loop = make([ok]);
    loop.signal({ kind: "serverDate", date: new Date("2026-10-25T10:07:00Z") });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find((e) => e.type === "clockSkew")).toMatchObject({ skewMs: 7 * 60_000 });
    events = [];
    const quiet = make([ok]);
    quiet.signal({ kind: "serverDate", date: new Date("2026-10-25T10:02:00Z") });
    quiet.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find((e) => e.type === "clockSkew")).toBeUndefined();
  });
});
