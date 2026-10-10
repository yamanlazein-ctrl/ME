/**
 * Field incident (2026-10-09): after a factory reset the WebView kept its stale
 * tokens while the fresh database had a new JWT secret and an incomplete setup
 * wizard. Every POST /api/auth/refresh was refused with 503 SETUP_REQUIRED —
 * never a 401/403, so the stored session was never dropped — and the install
 * logged 13,146 refresh requests in ~113 s while the UI sat on
 * «جاري استعادة الجلسة» forever.
 *
 * The guards: single-flight (concurrent 401s share one refresh) and an attempt
 * cap (a session that cannot be refreshed is dropped after a bounded number of
 * tries, so the AuthGate lands on the user picker instead of spinning forever).
 * `persistTokens` — any successful login — resets the budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "@/core/errors";
import { createTokenProvider, persistTokens } from "../TokenProvider";

type LocalStorageStub = Record<string, string>;

function stubLocalStorage() {
  const store: LocalStorageStub = {};
  const impl = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  // TokenProvider reads the BARE `localStorage` identifier, which on Node 26+
  // is a real global — stub both the global and the window property.
  vi.stubGlobal("localStorage", impl);
  vi.stubGlobal("window", { dispatchEvent: () => true, localStorage: impl });
  return store;
}

function stubRefreshContainer(impl: () => Promise<never>) {
  const calls = { count: 0 };
  vi.doMock("@/infrastructure/container", () => ({
    container: {
      auth: {
        repository: {
          refreshToken: async () => {
            calls.count += 1;
            return impl();
          },
        },
      },
    },
  }));
  return calls;
}

describe("onTokenExpired guards", () => {
  let store: LocalStorageStub;
  beforeEach(() => {
    vi.resetModules();
    store = stubLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/infrastructure/container");
    vi.restoreAllMocks();
  });

  it("caps a never-refreshable session (503 SETUP_REQUIRED forever) and drops the tokens", async () => {
    // The wizard never completes: the install gate answers 503 forever.
    const calls = stubRefreshContainer(() => {
      throw new ApiError(503, "يرجى إكمال معالج الإعداد", { code: "SETUP_REQUIRED" });
    });
    const { createTokenProvider: freshProvider } = await import("../TokenProvider");
    store["erp.auth.accessToken"] = "stale-access";
    store["erp.auth.refreshToken"] = "stale-refresh";

    const provider = freshProvider();
    const refresh = () => provider.onTokenExpired?.() ?? Promise.resolve(null);
    store["erp.auth.accessToken"] = "stale-access";
    store["erp.auth.refreshToken"] = "stale-refresh";

    // A hostile caller retries far more often than the cap — as the incident's
    // 13k-request loop did. The provider must bound the actual refresh calls.
    for (let i = 0; i < 1000; i++) {
      expect(await refresh()).toBeNull();
    }

    // At most MAX_REFRESH_ATTEMPTS hit the wire, and the session is dropped so
    // the AuthGate leaves the spinner for the user picker.
    expect(calls.count).toBeLessThanOrEqual(6);
    expect(store["erp.auth.accessToken"]).toBeUndefined();
    expect(store["erp.auth.refreshToken"]).toBeUndefined();
  });

  it("shares one refresh between concurrent 401s (single-flight, no reuse race)", async () => {
    const calls = stubRefreshContainer(async () => {
      // Rotation succeeded for whoever won the race.
      throw new Error("should not matter — count is what we assert");
    });
    const { createTokenProvider: freshProvider } = await import("../TokenProvider");
    store["erp.auth.refreshToken"] = "refresh-token";

    const provider = freshProvider();
    await Promise.all(
      Array.from({ length: 25 }, () => provider.onTokenExpired?.() ?? Promise.resolve(null)),
    );

    // 25 concurrent callers, ONE refresh on the wire — the racing duplicates
    // that used to trip the hub's rotation reuse-detection are gone.
    expect(calls.count).toBe(1);
  });

  it("gives a fresh budget after a successful login", async () => {
    const calls = stubRefreshContainer(() => {
      throw new ApiError(503, "setup", { code: "SETUP_REQUIRED" });
    });
    const { createTokenProvider: freshProvider, persistTokens: freshPersist } =
      await import("../TokenProvider");
    const provider = freshProvider();
    const refresh = () => provider.onTokenExpired?.() ?? Promise.resolve(null);
    store["erp.auth.refreshToken"] = "r";

    // Burn the whole budget: the count stops growing at the cap.
    for (let i = 0; i < 20; i++) await refresh();
    const capped = calls.count;
    await refresh();
    expect(calls.count).toBe(capped);

    // A real login re-seeds the session and resets the budget: the provider
    // attempts a refresh again instead of short-circuiting on the old cap.
    freshPersist("access-1", "refresh-1");
    expect(store["erp.auth.accessToken"]).toBe("access-1");
    await refresh();
    expect(calls.count).toBe(capped + 1);
  });
});
