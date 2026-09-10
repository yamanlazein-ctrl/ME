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
  disclaimer: "test",
  timestampUtc: "2026-01-01T12:00:00Z",
  cbsRates: [
    {
      currency: "USD",
      buy: 110,
      sell: 111,
      mid: 110.5,
      timestampUtc: "2026-01-01T11:00:00Z",
      isManualOverride: false,
    },
  ],
  marketRates: [
    {
      currency: "USD",
      buy: 14480,
      sell: 14520,
      mid: 14500,
      timestampUtc: "2026-01-01T10:00:00Z",
      isManualOverride: false,
    },
  ],
  effectiveRates: [
    {
      currency: "USD",
      buy: 14480,
      sell: 14520,
      mid: 14500,
      timestampUtc: "2026-01-01T10:00:00Z",
      isManualOverride: false,
    },
  ],
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
  it("parses a valid LiraScope payload into an available snapshot", async () => {
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
    expect(snap.sourceName).toBe("LiraScope");
    expect(snap.sourceUrl).toBe("https://lirascope.syria-cloud.sy");
  });

  it("prefers effectiveRates over marketRates and cbsRates", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () =>
        jsonResponse({
          effectiveRates: [{ currency: "USD", buy: 200, sell: 210, mid: 205 }],
          marketRates: [{ currency: "USD", buy: 100, sell: 110, mid: 105 }],
          cbsRates: [{ currency: "USD", buy: 50, sell: 55, mid: 52.5 }],
        }),
      ),
    });
    SERVICES_TO_STOP.push(service);
    await expect(service.refresh()).resolves.toBe(true);
    expect(service.getSnapshot().rate?.value).toBe(205);
  });

  it("falls back to marketRates when effectiveRates has no USD", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () =>
        jsonResponse({
          effectiveRates: [{ currency: "EUR", buy: 1, sell: 2, mid: 1.5 }],
          marketRates: [{ currency: "USD", buy: 100, sell: 110, mid: 105 }],
        }),
      ),
    });
    SERVICES_TO_STOP.push(service);
    await expect(service.refresh()).resolves.toBe(true);
    expect(service.getSnapshot().rate?.value).toBe(105);
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
    ["missing USD", { marketRates: [{ currency: "EUR", buy: 1, sell: 2, mid: 1.5 }] }],
    ["negative mid", { marketRates: [{ currency: "USD", buy: 1, sell: 2, mid: -5 }] }],
    ["non-numeric mid", { marketRates: [{ currency: "USD", buy: 1, sell: 2, mid: "abc" }] }],
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      sourceName: string;
      sourceUrl: string;
      rate: { value: number };
    };
    expect(body.available).toBe(true);
    expect(body.rate.value).toBe(14500);
    expect(body.sourceName).toBe("LiraScope");
    expect(body.sourceUrl).toBe("https://lirascope.syria-cloud.sy");
  });

  it("returns available:false without throwing when there is no cached rate", async () => {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        throw new Error("offline");
      }),
    });
    SERVICES_TO_STOP.push(service);

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it("never throws on the route even if the service misbehaves", async () => {
    const service = {
      getSnapshot: () => {
        throw new Error("boom");
      },
    } as unknown as FxRateService;

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    // Route must not 500 — graceful degradation for a display widget.
    expect(res.status).toBe(200);
  });
});
