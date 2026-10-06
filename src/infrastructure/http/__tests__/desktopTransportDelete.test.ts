import { describe, it, expect, beforeAll } from "vitest";
import { installDesktopTransport } from "@/infrastructure/http/desktopTransport";
import { BaseHttpClient } from "@/infrastructure/http/BaseHttpClient";

/**
 * The 204 / replayed-DELETE regression.
 *
 * The delete endpoints answer 204 with an empty body. The desktop transport
 * rebuilt a `Response` from the pipe's `String` body, and a null-body status
 * with a NON-null body throws `TypeError` per the Fetch standard. The throw
 * escaped the patched `fetch`, was wrapped as a NETWORK error, and was RETRIED
 * — so a delete that had already committed was sent a second time with the
 * same OCC token, and the replay failed the version check. The operator saw
 * "تم تعديل بيانات العميل من جلسة أخرى (الإصدار 2)" for a delete that had in
 * fact succeeded.
 *
 * These tests drive the real transport and the real HTTP client against a fake
 * sidecar that behaves like the Express app: 204 on the first call, and a 422
 * OCC refusal if — and only if — the request is replayed.
 */

type PipeRequest = { method: string; path: string; body: string | null };
type PipeResponse = {
  status: number;
  headers: [string, string][];
  body: string;
  error?: string | null;
  elapsedUs: number;
};
type RecordedRequest = PipeRequest;

type FakeSidecar = {
  requests: RecordedRequest[];
  /** Overridable so a test can answer with something other than 204. */
  respond: (method: string, path: string, body: string | null) => PipeResponse;
};

type DesktopGlobal = typeof globalThis & {
  window?: unknown;
  fetch?: unknown;
};

const OCC_BODY = JSON.stringify({
  code: "VALIDATION",
  message: "تعارض في الإصدار: الإصدار الحالي للعميل 2، والإصدار الذي قرأته 1.",
});

/** A sidecar that commits the delete once and refuses any replay. */
function fakeSidecar(): FakeSidecar {
  const requests: RecordedRequest[] = [];
  const sidecar: FakeSidecar = {
    requests,
    respond: (method, path, body) => {
      requests.push({ method, path, body });
      if (requests.length === 1) {
        return { status: 204, headers: [], body: "", error: null, elapsedUs: 1200 };
      }
      // A replay: the row is already cancelled at version 2, so the OCC check
      // refuses. This is the exact failure the operator reported.
      return { status: 422, headers: [], body: OCC_BODY, error: null, elapsedUs: 900 };
    },
  };
  return sidecar;
}

/**
 * One window for the whole file. `getInvoke()` memoises the IPC function in a
 * module-level variable, so installing a fresh window per test would keep
 * calling the FIRST test's sidecar. The window therefore delegates to
 * `activeSidecar`, which each test replaces.
 */
let activeSidecar: FakeSidecar;

function desktopFetch(): typeof fetch {
  const g = globalThis as DesktopGlobal;
  if (!g.window) throw new Error("fake desktop window is not installed");
  return (g.window as { fetch: typeof fetch }).fetch;
}

/**
 * `defineProperty` instead of a plain assignment: a direct `globalThis.window
 * = …` narrows the global's type for the rest of the scope, which then breaks
 * `installDesktopTransport`'s `Window & typeof globalThis` check.
 */
function defineGlobal(name: "window" | "fetch", value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeAll(() => {
  const win = {
    fetch: (): never => {
      throw new Error("the asset protocol must stay on the real fetch");
    },
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: { req: PipeRequest }): Promise<PipeResponse> => {
        if (cmd !== "api") throw new Error(`unexpected IPC command ${cmd}`);
        return activeSidecar.respond(args.req.method, args.req.path, args.req.body);
      },
    },
  };
  defineGlobal("window", win);
  installDesktopTransport();
  // In a WebView2 document `window` IS `globalThis`, so the patched fetch is
  // what the HTTP client resolves. Node keeps them separate; mirror the browser
  // by re-reading the (now patched) window.fetch onto the global.
  defineGlobal("fetch", desktopFetch());
});


describe("desktop transport — null-body statuses", () => {
  it("resolves a 204 instead of throwing (a null-body status needs a null body)", async () => {
    const sidecar = fakeSidecar();
    activeSidecar = sidecar;

    const res = await desktopFetch()("/api/customers/11111111-1111-1111-1111-111111111111", {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    expect(res.status).toBe(204);
    expect(sidecar.requests).toHaveLength(1);
  });

  it("still carries a JSON body on a normal response", async () => {
    const sidecar = fakeSidecar();
    sidecar.respond = () => ({
      status: 200,
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ version: 7 }),
      error: null,
      elapsedUs: 800,
    });
    activeSidecar = sidecar;

    const res = await desktopFetch()("/api/customers/x");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ version: 7 });
  });
});

describe("party delete over the desktop transport", () => {
  it("issues exactly ONE delete and reports success (no replay, no phantom OCC)", async () => {
    const sidecar = fakeSidecar();
    activeSidecar = sidecar;
    const client = new BaseHttpClient();

    await expect(
      client.delete("/api/customers/11111111-1111-1111-1111-111111111111", {
        body: { expectedVersion: 1, confirmCascade: false },
        params: { expectedVersion: "1" },
      }),
    ).resolves.toMatchObject({ status: 204 });

    // The whole bug in one assertion: a second server-side request means the
    // client replayed a mutation it had already sent.
    expect(sidecar.requests).toHaveLength(1);
    expect(sidecar.requests[0].method).toBe("DELETE");
    expect(sidecar.requests[0].body).toContain('"expectedVersion":1');
  });

  it("sends the DELETE body and the OCC token over the pipe", async () => {
    const sidecar = fakeSidecar();
    activeSidecar = sidecar;
    const client = new BaseHttpClient();

    await client.delete("/api/customers/abc", {
      body: { expectedVersion: 3, confirmCascade: true },
      params: { expectedVersion: "3", confirmCascade: "true" },
    });

    expect(sidecar.requests[0].path).toBe("/api/customers/abc?expectedVersion=3&confirmCascade=true");
    expect(JSON.parse(sidecar.requests[0].body ?? "{}")).toEqual({
      expectedVersion: 3,
      confirmCascade: true,
    });
  });
});

describe("network-error replay safety", () => {
  const client = new BaseHttpClient({ retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });

  it("never replays a DELETE after an ambiguous network failure", async () => {
    let calls = 0;
    defineGlobal("fetch", async () => {
      calls++;
      throw new TypeError("Response constructor: Invalid response status code 204");
    });

    await expect(client.delete("/api/customers/abc", { body: { expectedVersion: 1 } })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("still retries a GET, which cannot double-apply anything", async () => {
    let calls = 0;
    defineGlobal("fetch", async () => {
      calls++;
      throw new TypeError("network down");
    });

    await expect(client.get("/api/customers")).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("still retries an idempotency-keyed POST", async () => {
    let calls = 0;
    defineGlobal("fetch", async (url: string, init: RequestInit) => {
      calls++;
      const headers = new Headers(init.headers as HeadersInit);
      expect(headers.get("Idempotency-Key")).toBeTruthy();
      expect(String(url)).toContain("/api/customers");
      throw new TypeError("network down");
    });

    await expect(client.post("/api/customers", { name: "x" })).rejects.toThrow();
    expect(calls).toBe(3);
  });
});
