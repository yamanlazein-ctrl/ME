/**
 * Regression — the «جاري استعادة الجلسة…» forever-spinner deadlock
 * (field incident, 2026-10-09, boots ac342333/e1579c10).
 *
 * A factory reset deletes the user but the WebView keeps its tokens: the JWT
 * still verifies (the secret survives in secrets.dat) while `resolveSessionIdentity`
 * answers unknown → every business route AND /api/auth/me AND /api/auth/refresh
 * answer 401. The refresh POST travels through the SAME BaseHttpClient that
 * carries authInterceptor, so the refresh's own 401 re-entered onTokenExpired,
 * which returned the in-flight refresh promise — the refresh awaited ITSELF.
 * Nothing ever settled: useCurrentUser stayed pending, the AuthGate spinner
 * never left, and clearTokens was unreachable while the stale session stayed
 * on disk across reinstalls.
 *
 * This test runs the REAL production modules (BaseHttpClient + authInterceptor
 * + TokenProvider + AuthApiService) wired exactly as container.ts wires them,
 * with only fetch stubbed to the field server's 401 answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseHttpClient } from "@/infrastructure/http/BaseHttpClient";
import { authInterceptor } from "@/infrastructure/http/interceptors";
import { createTokenProvider } from "../TokenProvider";
import { AuthApiService } from "@/infrastructure/api/AuthApiService";

type Store = Record<string, string>;

function stubGlobals(store: Store, fetchImpl: typeof fetch) {
  const impl = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  };
  vi.stubGlobal("localStorage", impl);
  vi.stubGlobal("window", { dispatchEvent: () => true, localStorage: impl });
  vi.stubGlobal("fetch", fetchImpl);
}

/** The field server state: deleted user ⇒ 401 UNAUTHORIZED on every call. */
function server401Fetch(log: string[]) {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    log.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(
      JSON.stringify({ code: "UNAUTHORIZED", message: "المستخدم غير موجود", statusCode: 401 }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const DEADLOCK = (ms = 3000) =>
  new Promise<string>((r) => setTimeout(() => r("DEADLOCK — never settled"), ms));

describe("stale-session cold boot (real wiring, 401 everywhere)", () => {
  let store: Store;
  const wire: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    store = {};
    wire.length = 0;
    stubGlobals(store, server401Fetch(wire));
    // Mirror src/infrastructure/container.ts: the ONE apiClient carries
    // authInterceptor(createTokenProvider()), and TokenProvider dynamically
    // imports container.auth.repository — which uses that same client.
    vi.doMock("@/infrastructure/container", () => {
      const client = new BaseHttpClient({ baseUrl: "http://local", timeoutMs: 2000 });
      client.addInterceptor(authInterceptor(createTokenProvider()));
      return { container: { auth: { repository: new AuthApiService(client) } } };
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/infrastructure/container");
    vi.restoreAllMocks();
  });

  it("onTokenExpired settles, clears the dead session, and bounds the wire", async () => {
    const { createTokenProvider: fresh } = await import("../TokenProvider");
    store["erp.auth.accessToken"] = "stale-access";
    store["erp.auth.refreshToken"] = "stale-refresh";

    const provider = fresh();
    const outcome = await Promise.race([
      provider.onTokenExpired?.().then((r) => `settled:${r}`),
      DEADLOCK(),
    ]);

    // Before the fix this was "DEADLOCK — never settled".
    expect(outcome).toBe("settled:null");
    // A rejected credential wipes the stored session → AuthGate reaches the picker.
    expect(store["erp.auth.accessToken"]).toBeUndefined();
    expect(store["erp.auth.refreshToken"]).toBeUndefined();
    // The refresh itself may be re-fired by the interceptor's bounded retry
    // (maxRetries=2), but the flight TERMINATES — no infinite 401 storm.
    const refreshes = wire.filter((l) => l.startsWith("POST")).length;
    expect(refreshes).toBeGreaterThan(0);
    expect(refreshes).toBeLessThanOrEqual(6);
  });

  it("the /me cold-boot request settles and surfaces the auth failure", async () => {
    const { container } = await import("@/infrastructure/container");
    store["erp.auth.accessToken"] = "stale-access";
    store["erp.auth.refreshToken"] = "stale-refresh";

    const outcome = await Promise.race([
      container.auth.repository
        .getCurrentUser({ tenantId: "t" } as never)
        .then((u) => `settled:${JSON.stringify(u)}`)
        .catch((e: { code?: string }) => `rejected:${e?.code ?? "unknown"}`),
      DEADLOCK(),
    ]);

    // useCurrentUser's queryFn must SEE the failure (isAuthFailure → clearTokens,
    // no retry, isError=true) instead of pending forever behind the spinner.
    expect(outcome).toBe("rejected:UNAUTHORIZED");
    expect(store["erp.auth.accessToken"]).toBeUndefined();
    expect(store["erp.auth.refreshToken"]).toBeUndefined();
  });
});
