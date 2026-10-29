import { describe, expect, it } from "vitest";
import {
  InsufficientStorageError,
  runFirstDownload,
  type FirstDownloadDeps,
  type FirstDownloadProgress,
} from "../../src/core/firstDownload";

/** A fake hub with `total` units served 100 per page; the cursor persists across runs like the real one. */
function fakeDevice(total: number, startCursor = 0, freeBytes = 10 ** 12) {
  const state = { cursor: startCursor };
  const progress: FirstDownloadProgress[] = [];
  const deps: FirstDownloadDeps & { state: typeof state; progress: typeof progress } = {
    state,
    progress,
    headSeq: async () => total,
    cursor: async () => state.cursor,
    pullPage: async () => {
      const n = Math.max(0, Math.min(100, total - state.cursor));
      state.cursor += n;
      return { pulled: n, applied: n, failed: 0 };
    },
    freeDiskBytes: async () => freeBytes,
    onProgress: (p) => progress.push(p),
  };
  return deps;
}

describe("firstDownload (FR-07)", () => {
  it("loops the pull until the stream is empty and reports percent = cursor ÷ headSeq", async () => {
    const dev = fakeDevice(250);
    const result = await runFirstDownload(dev);
    expect(result).toMatchObject({ done: true, applied: 250, cursor: 250, headSeq: 250 });
    expect(dev.progress.map((p) => Math.round(p.percent * 100))).toEqual([40, 80, 100, 100]);
  });

  it("resumes from the stored cursor after a kill after page 2", async () => {
    const dev = fakeDevice(300);
    let pages = 0;
    dev.afterPage = () => {
      pages += 1;
      if (pages === 2) throw new Error("killed");
    };
    await expect(runFirstDownload(dev)).rejects.toThrow("killed");
    expect(dev.state.cursor).toBe(200);
    dev.afterPage = undefined;
    const resumed = await runFirstDownload(dev);
    expect(resumed).toMatchObject({ done: true, cursor: 300 });
    expect(resumed.applied).toBe(100); // only the missing page was fetched again
  });

  it("refuses with both numbers when the free space is short (E15)", async () => {
    const dev = fakeDevice(100_000, 0, 50 * 1024 * 1024);
    const error = await runFirstDownload(dev).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientStorageError);
    expect(error).toMatchObject({ neededBytes: 100_000 * 2048, freeBytes: 50 * 1024 * 1024 });
    expect(dev.state.cursor).toBe(0);
  });

  it("stops when the hub refuses the device, and when pages keep failing without progress", async () => {
    const trust = fakeDevice(100);
    trust.pullPage = async () => ({
      pulled: 1,
      applied: 0,
      failed: 0,
      deviceTrust: { code: "SYNC_DEVICE_REVOKED", message: "x" },
    });
    expect(await runFirstDownload(trust)).toMatchObject({ done: false, stoppedBy: "deviceTrust" });

    const failing = fakeDevice(100);
    failing.pullPage = async () => ({ pulled: 50, applied: 0, failed: 5 });
    expect(await runFirstDownload(failing)).toMatchObject({ done: false, stoppedBy: "failed" });
  });

  it("outlasts the pull's 5-attempt park budget: a unit that fails 5 times then parks does not end the download", async () => {
    const dev = fakeDevice(10);
    let calls = 0;
    dev.pullPage = async () => {
      calls += 1;
      if (calls <= 5) return { pulled: 1, applied: 0, failed: 1 }; // held, cursor does not move
      if (calls === 6) {
        dev.state.cursor = 10; // parked as dead: the stream passes it
        return { pulled: 1, applied: 0, failed: 0 };
      }
      return { pulled: 0, applied: 0, failed: 0 };
    };
    expect(await runFirstDownload(dev)).toMatchObject({ done: true, cursor: 10 });
  });
});
