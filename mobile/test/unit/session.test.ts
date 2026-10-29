import { describe, expect, it, vi } from "vitest";
import {
  PinLoginError,
  createSessionService,
  pendingLogoutMessage,
  type SessionDeps,
} from "../../src/core/session";

function setup(
  overrides: Partial<SessionDeps> = {},
  fetchImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const secrets = new Map<string, string>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deps: SessionDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!fetchImpl) throw new Error("no network");
      return fetchImpl(url, init);
    }) as unknown as typeof fetch,
    hubUrl: () => "https://hub.example",
    tenantId: () => "tenant-1",
    deviceAuthHeader: async () => "Bearer device",
    getSecret: async (k) => secrets.get(k) ?? null,
    setSecret: async (k, v) => void secrets.set(k, v),
    deleteSecret: async (k) => void secrets.delete(k),
    // A stand-in verifier (the real Argon2id one is native): hash = "h:" + pin.
    hashPin: async (pin) => `h:${pin}`,
    verifyPin: async (pin, stored) => stored === `h:${pin}`,
    pendingCount: async () => 0,
    now: () => new Date("2026-10-25T10:00:00Z"),
    ...overrides,
  };
  return { svc: createSessionService(deps), secrets, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const loginAnswer = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  user: { id: "u1", name: "محمد", role: "accountant" },
};

describe("session service (T068)", () => {
  it("pinLogin stores the tokens and the offline verifier for that user", async () => {
    const { svc, secrets } = setup({}, () => json(200, loginAnswer));
    const s = await svc.pinLogin("u1", "4821");
    expect(s).toMatchObject({ userId: "u1", role: "accountant", accessToken: "access-1" });
    expect(secrets.get("pin.u1")).toBe("h:4821");
    expect((await svc.current())?.refreshToken).toBe("refresh-1");
  });

  it("offline sign-in succeeds with the right PIN and fails with a wrong one", async () => {
    const { svc } = setup({}, () => json(200, loginAnswer));
    await svc.pinLogin("u1", "4821");
    const user = { id: "u1", name: "محمد", role: "accountant" as const };
    expect((await svc.offlineLogin("u1", "4821", user)).userId).toBe("u1");
    await expect(svc.offlineLogin("u1", "0000", user)).rejects.toMatchObject({ kind: "invalid" });
    await expect(svc.offlineLogin("u2", "4821", { ...user, id: "u2" })).rejects.toBeInstanceOf(
      PinLoginError,
    );
  });

  it("a refused refresh (401) ends the session; another 403 elsewhere does not", async () => {
    let status = 401;
    const { svc } = setup({}, (url) =>
      url.endsWith("/api/auth/pin-login") ? json(200, loginAnswer) : json(status, {}),
    );
    await svc.pinLogin("u1", "4821");
    expect(await svc.refresh()).toBe(false);
    expect(await svc.current()).toBeNull();

    await svc.pinLogin("u1", "4821");
    status = 500;
    expect(await svc.refresh()).toBe(true); // a server error keeps the session
    status = 403;
    expect(await svc.refresh()).toBe(false); // 403 on REFRESH ends it
  });

  it("a network failure during refresh keeps the session (airplane mode)", async () => {
    const calls = { n: 0 };
    const { svc } = setup({}, (url) => {
      if (url.endsWith("/pin-login")) return json(200, loginAnswer);
      calls.n++;
      throw new Error("offline");
    });
    await svc.pinLogin("u1", "4821");
    expect(await svc.refresh()).toBe(true);
    expect((await svc.current())?.userId).toBe("u1");
    expect(calls.n).toBe(1);
  });

  it("keeps a one-year-old session: nothing expires it locally", async () => {
    const { svc, secrets } = setup({ now: () => new Date("2027-10-24T10:00:00Z") });
    secrets.set(
      "session",
      JSON.stringify({
        userId: "u1",
        name: "x",
        role: "admin",
        accessToken: "a",
        refreshToken: "r",
        signedInAt: "2026-10-25T10:00:00.000Z",
      }),
    );
    expect((await svc.current())?.userId).toBe("u1");
  });

  it("logout with pending units asks for confirmation first (E8), then clears the tokens", async () => {
    const { svc, calls } = setup({ pendingCount: async () => 3 }, (url) =>
      url.endsWith("/pin-login") ? json(200, loginAnswer) : json(204, {}),
    );
    await svc.pinLogin("u1", "4821");
    expect(await svc.logout()).toEqual({ needsConfirm: true, pending: 3 });
    expect(await svc.current()).not.toBeNull();
    expect(pendingLogoutMessage(3)).toBe("3 عمليات لم تُرسل بعد");
    expect(await svc.logout({ confirmed: true })).toEqual({ needsConfirm: false });
    expect(await svc.current()).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/api/auth/logout"))).toBe(true);
  });

  it("the roster is cached after the first fetch, so the picker works offline", async () => {
    let online = true;
    const { svc } = setup({}, () => {
      if (!online) throw new Error("offline");
      return json(200, { users: [{ id: "u1", name: "محمد", role: "admin", email: "a@b.c" }] });
    });
    expect((await svc.roster()).map((u) => u.name)).toEqual(["محمد"]);
    online = false;
    expect((await svc.roster()).map((u) => u.name)).toEqual(["محمد"]);
    void vi;
  });
});

describe("first PIN and sign-in errors (users without a PIN could never sign in)", () => {
  it("the roster keeps hasPin=false for a user without a PIN", async () => {
    const { svc } = setup({}, () =>
      json(200, {
        users: [
          { id: "u1", name: "أ", role: "admin", hasPin: true },
          { id: "u2", name: "ب", role: "accountant", hasPin: false },
        ],
      }),
    );
    const users = await svc.roster();
    expect(users.map((u) => u.hasPin)).toEqual([true, false]);
  });

  it("setPin posts to /api/auth/set-pin with the device's proof and surfaces the hub's refusal", async () => {
    const { svc, calls } = setup({}, (url) =>
      url.endsWith("/api/auth/set-pin")
        ? json(422, {
            code: "VALIDATION_ERROR",
            message: "البيانات المدخلة غير صحيحة",
            details: { pin: ["هذا الرقم السري ضعيف جداً"] },
          })
        : json(200, {}),
    );
    await expect(svc.setPin("u2", "1234")).rejects.toMatchObject({
      message: "هذا الرقم السري ضعيف جداً",
      kind: "invalid",
    });
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://hub.example/api/auth/set-pin");
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer device");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      userId: "u2",
      pin: "1234",
      tenantId: "tenant-1",
    });
  });

  it("names each refusal: wrong PIN, too many tries, server error, unknown device", async () => {
    let answer = json(401, { code: "INVALID_PIN", message: "x" });
    const { svc } = setup({}, () => answer);
    await expect(svc.pinLogin("u1", "4821")).rejects.toMatchObject({
      message: "الرقم السري غير صحيح",
    });
    answer = json(429, {});
    await expect(svc.pinLogin("u1", "4821")).rejects.toMatchObject({
      message: expect.stringContaining("محاولات كثيرة"),
    });
    answer = json(503, {});
    await expect(svc.pinLogin("u1", "4821")).rejects.toMatchObject({
      message: expect.stringContaining("خطأ في المركز"),
    });
    answer = json(401, { code: "DEVICE_PROOF_REQUIRED" });
    await expect(svc.setPin("u1", "4821")).rejects.toMatchObject({
      message: expect.stringContaining("أعد ربط الهاتف"),
    });
  });

  it("setPin without a network says it needs a connection", async () => {
    const { svc } = setup();
    await expect(svc.setPin("u1", "4821")).rejects.toMatchObject({ kind: "network" });
  });
});
