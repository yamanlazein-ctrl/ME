import { describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/auth/TokenProvider", () => ({ getAccessToken: () => "token" }));
vi.mock("@/lib/api-base-url", () => ({ getApiBaseUrl: () => "" }));
vi.mock("@/lib/sync-device", () => ({
  getRegisteredSyncDeviceId: () => null,
  adoptSyncDeviceId: () => undefined,
}));

const { runSyncNow, setDataRefresher } = await import("./sync-engine");

const answer = (localDataVersion: number) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ pushed: 0, failed: 0, skipped: false, localDataVersion })),
  );

describe("one refresh path for every sync trigger", () => {
  it("re-reads the screen only when the backend's data version moved", async () => {
    const refresh = vi.fn(async () => undefined);
    setDataRefresher(refresh);

    vi.stubGlobal("fetch", answer(3));
    await runSyncNow(); // first answer: baseline only
    await runSyncNow(); // same version: nothing changed
    expect(refresh).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", answer(4));
    await runSyncNow(); // a cycle (any trigger) applied peers' data
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
