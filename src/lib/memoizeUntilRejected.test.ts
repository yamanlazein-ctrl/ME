import { describe, it, expect, vi } from "vitest";
import { memoizeUntilRejected } from "./memoizeUntilRejected";

/**
 * Regression test for F03 (Phase 1 foundation audit): server.ts memoized a
 * dynamic import() in a plain `let cached` with an `if (!cached)` guard — a
 * Promise is truthy even after rejecting, so a single transient failure
 * (a known Vite dev-server module-runner race) poisoned every subsequent
 * request until the process restarted, with the generic error page shown
 * forever and no way to tell why.
 */
describe("memoizeUntilRejected (F03 regression)", () => {
  it("retries the factory on the next call after a rejection, instead of replaying the same dead promise forever", async () => {
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce("ok");

    const memoized = memoizeUntilRejected(factory);

    await expect(memoized()).rejects.toThrow("transient failure");
    // This is the exact bug: before the fix, a second call would return
    // the SAME rejected promise without invoking the factory again.
    expect(factory).toHaveBeenCalledTimes(1);

    await expect(memoized()).resolves.toBe("ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("stays memoized (does not re-invoke the factory) once it succeeds", async () => {
    const factory = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const memoized = memoizeUntilRejected(factory);

    await expect(memoized()).resolves.toBe("ok");
    await expect(memoized()).resolves.toBe("ok");
    await expect(memoized()).resolves.toBe("ok");

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying on every call while the factory keeps rejecting", async () => {
    const factory = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("still down"));
    const memoized = memoizeUntilRejected(factory);

    await expect(memoized()).rejects.toThrow("still down");
    await expect(memoized()).rejects.toThrow("still down");
    await expect(memoized()).rejects.toThrow("still down");

    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("does not invoke the factory twice for concurrent in-flight calls (still one shared promise until settled)", async () => {
    let resolveFactory: (value: string) => void;
    const factory = vi.fn<() => Promise<string>>(
      () =>
        new Promise<string>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const memoized = memoizeUntilRejected(factory);

    const p1 = memoized();
    const p2 = memoized();
    resolveFactory!("ok");

    await expect(p1).resolves.toBe("ok");
    await expect(p2).resolves.toBe("ok");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
