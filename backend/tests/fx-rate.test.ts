import { describe, expect, it, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FxRateService } from "../src/infrastructure/fx/FxRateService.js";
import { registerFxRoutes } from "../src/presentation/routes/fx.route.js";

/**
 * Unit tests for the display-only FX reference-rate service + endpoint.
 * These exercise the cache, failure handling, schema validation and the HTTP
 * contract consumed by the header badge (available/stale/never-throws).
 */

const OK_PAYLOAD = {
  usdsypd: {
    symbol: "usdsypd",
    value: 14500.0,
    sell: 14520.0,
    buy: 14480.0,
    price_updated_at: "2026-01-01T10:00:00Z",
  },
};

type FetchHandler = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

function makeFetch(handler: FetchHandler): typeof fetch {
  return handler as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SERVICES_TO_STOP: FxRateService[] = [];
const SERVERS_TO_CLOSE: Server[] = [];

afterEach(() => {
  for (const s of SERVICES_TO_STOP) s.stop();
  SERVICES_TO_STOP.length = 0;
  for (const s of SERVERS_TO_CLOSE) s.close();
  SERVERS_TO_CLOSE.length = 0;
});

describe("FxRateService", () => {
  it("parses a valid upstream payload into an available snapshot", async () => {
    let calls = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        calls++;
        return jsonResponse(OK_PAYLOAD);
      }),
      now: () => 1_000_000,
    });
    SERVICES_TO_STOP.push(service);

    const ok = await service.refresh();
    expect(ok).toBe(true);
    expect(calls).toBe(1);

    const snap = service.getSnapshot();
    expect(snap.available).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.rate?.value).toBe(14500);
    expect(snap.rate?.sell).toBe(14520);
    expect(snap.rate?.buy).toBe(14480);
    expect(snap.priceUpdatedAt).toBe("2026-01-01T10:00:00Z");
    expect(snap.fetchedAt).toBe(new Date(1_000_000).toISOString());
    // Mandatory provider attribution
    expect(snap.sourceName).toBe("أخبار الليرة");
    expect(snap.sourceUrl).toBe("https://liranews.info");
  });

  it("keeps the last known price (flagged stale) when the upstream fails afterwards", async () => {
    let fail = false;
    let nowMs = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        if (fail) throw new Error("connection reset");
        return jsonResponse(OK_PAYLOAD);
      }),
      now: () => nowMs,
    });
    SERVICES_TO_STOP.push(service);

    nowMs = 0;
    await expect(service.refresh()).resolves.toBe(true);
    fail = true;
    nowMs = 3 * 60 * 60 * 1000; // 3h later — beyond the stale threshold
    await expect(service.refresh()).resolves.toBe(false);

    const snap = service.getSnapshot();
    expect(snap.available).toBe(true); // graceful: last known price still shown
    expect(snap.stale).toBe(true);
    expect(snap.rate?.value).toBe(14500);
  });

  it("reports NO_DATA before any fetch and UPSTREAM_DOWN after a failed fetch", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        throw new Error("dns failure");
      }),
    });
    SERVICES_TO_STOP.push(service);

    expect(service.getSnapshot()).toMatchObject({
      available: false,
      reason: "NO_DATA",
    });

    await service.refresh();
    expect(service.getSnapshot()).toMatchObject({
      available: false,
      reason: "UPSTREAM_DOWN",
    });
  });

  it.each([
    ["wrong shape", { unexpected: true }],
    ["missing value", { usdsypd: { sell: 1 } }],
    ["negative value", { usdsypd: { value: -5 } }],
    ["non-numeric value", { usdsypd: { value: "abc" } }],
    ["HTTP 500", null], // handled separately below
  ])("treats malformed payload (%s) as a failed fetch", async (_name, body) => {
    if (body === null) return; // placeholder row; real HTTP case covered next
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse(body)),
    });
    SERVICES_TO_STOP.push(service);
    await expect(service.refresh()).resolves.toBe(false);
    expect(service.getSnapshot().available).toBe(false);
  });

  it("treats an upstream HTTP error as a failed fetch", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse({ error: "boom" }, 500)),
    });
    SERVICES_TO_STOP.push(service);
    await expect(service.refresh()).resolves.toBe(false);
    expect(service.getSnapshot().available).toBe(false);
  });

  it("aborts a hanging upstream response after the fetch timeout", async () => {
    const service = new FxRateService({
      fetchTimeoutMs: 50,
      fetchImpl: makeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    SERVICES_TO_STOP.push(service);
    await expect(service.refresh()).resolves.toBe(false);
    expect(service.getSnapshot().available).toBe(false);
  });

  it("coalesces concurrent refreshes into a single upstream request", async () => {
    let calls = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse(OK_PAYLOAD);
      }),
    });
    SERVICES_TO_STOP.push(service);

    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("GET /fx/reference-rate (route contract)", () => {
  it("serves the cached snapshot with HTTP 200 and attribution", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse(OK_PAYLOAD)),
      now: () => Date.now(),
    });
    SERVICES_TO_STOP.push(service);
    await service.refresh();

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    expect(res.status).toBe(200); // never an error status — the UI degrades gracefully
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.available).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.sourceName).toBe("أخبار الليرة");
    expect(body.sourceUrl).toBe("https://liranews.info");
    expect((body.rate as Record<string, unknown>).value).toBe(14500);
  });

  it("still returns HTTP 200 with available:false when the provider never responded", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        throw new Error("offline");
      }),
    });
    SERVICES_TO_STOP.push(service);
    await service.refresh();

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.available).toBe(false);
  });

  it("requires authentication (401 when the auth middleware rejects)", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse(OK_PAYLOAD)),
    });
    SERVICES_TO_STOP.push(service);

    const app = express();
    const router = express.Router();
    const rejectingAuth: express.RequestHandler = (_req, res) => {
      res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول", statusCode: 401 });
    };
    registerFxRoutes(router, service, rejectingAuth);
    app.use(router);
    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    expect(res.status).toBe(401);
  });
});
