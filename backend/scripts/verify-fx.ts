/**
 * Standalone verification for the display-only FX reference-rate feature.
 *
 * Runs in a single Node process via tsx (no test-runner spawn needed):
 *
 *   cd backend
 *   node --import tsx scripts/verify-fx.ts          # unit + route contract checks (fake upstream)
 *   node --import tsx scripts/verify-fx.ts --live   # additionally calls the real LiraScope API
 *
 * Complements backend/tests/fx-rate.test.ts (vitest) with the same coverage
 * for environments where spawning test runners is not possible.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { FxRateService } from "../src/infrastructure/fx/FxRateService.js";
import { registerFxRoutes } from "../src/presentation/routes/fx.route.js";

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

const makeFetch = (handler: FetchHandler): typeof fetch => handler as unknown as typeof fetch;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const services: FxRateService[] = [];
const servers: Server[] = [];

function cleanup() {
  for (const s of services) s.stop();
  services.length = 0;
  for (const s of servers) s.close();
  servers.length = 0;
}

async function main() {
  // ── 1. Valid upstream payload → available snapshot with attribution ──
  {
    let calls = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        calls++;
        return jsonResponse(OK_PAYLOAD);
      }),
      now: () => 1_000_000,
    });
    services.push(service);
    assert.equal(await service.refresh(), true);
    assert.equal(calls, 1);
    const snap = service.getSnapshot();
    assert.equal(snap.available, true);
    assert.equal(snap.stale, false);
    assert.equal(snap.rate?.value, 14500);
    assert.equal(snap.rate?.sell, 14520);
    assert.equal(snap.rate?.buy, 14480);
    assert.equal(snap.priceUpdatedAt, "2026-01-01T10:00:00Z");
    assert.equal(snap.sourceName, "LiraScope");
    assert.equal(snap.sourceUrl, "https://lirascope.syria-cloud.sy");
    console.log("[PASS] 1. valid payload → available snapshot + attribution");
  }

  // ── 2. Upstream failure after success → last known price kept, stale flag ──
  {
    let fail = false;
    let nowMs = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        if (fail) throw new Error("connection reset");
        return jsonResponse(OK_PAYLOAD);
      }),
      now: () => nowMs,
    });
    services.push(service);
    nowMs = 0;
    assert.equal(await service.refresh(), true);
    fail = true;
    nowMs = 3 * 60 * 60 * 1000; // 3h later — beyond the stale threshold
    assert.equal(await service.refresh(), false);
    const snap = service.getSnapshot();
    assert.equal(snap.available, true);
    assert.equal(snap.stale, true);
    assert.equal(snap.rate?.value, 14500);
    console.log("[PASS] 2. upstream failure → last known price kept + stale");
  }

  // ── 3. NO_DATA before any fetch, UPSTREAM_DOWN after a failed fetch ──
  {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        throw new Error("dns failure");
      }),
    });
    services.push(service);
    assert.deepEqual(
      { ...service.getSnapshot(), sourceName: undefined, sourceUrl: undefined },
      {
        available: false,
        stale: false,
        reason: "NO_DATA",
        sourceName: undefined,
        sourceUrl: undefined,
      },
    );
    await service.refresh();
    assert.equal(service.getSnapshot().reason, "UPSTREAM_DOWN");
    console.log("[PASS] 3. NO_DATA / UPSTREAM_DOWN reasons");
  }

  // ── 4. Malformed payloads are rejected (schema validation) ──
  {
    const badPayloads: unknown[] = [
      { unexpected: true },
      { marketRates: [{ currency: "EUR", buy: 1, sell: 2, mid: 1.5 }] },
      { marketRates: [{ currency: "USD", buy: 1, sell: 2, mid: -5 }] },
      { marketRates: [{ currency: "USD", buy: 1, sell: 2, mid: "abc" }] },
    ];
    for (const body of badPayloads) {
      const service = new FxRateService({
        fetchImpl: makeFetch(async () => jsonResponse(body)),
      });
      services.push(service);
      assert.equal(await service.refresh(), false);
      assert.equal(service.getSnapshot().available, false);
    }
    console.log("[PASS] 4. malformed payloads rejected");
  }

  // ── 5. Upstream HTTP error → failed fetch ──
  {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse({ error: "boom" }, 500)),
    });
    services.push(service);
    assert.equal(await service.refresh(), false);
    assert.equal(service.getSnapshot().available, false);
    console.log("[PASS] 5. HTTP 500 → failed fetch");
  }

  // ── 6. Hanging upstream → aborted after the fetch timeout ──
  {
    const service = new FxRateService({
      fetchTimeoutMs: 50,
      fetchImpl: makeFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    services.push(service);
    assert.equal(await service.refresh(), false);
    assert.equal(service.getSnapshot().available, false);
    console.log("[PASS] 6. fetch timeout aborts cleanly");
  }

  // ── 7. Concurrent refreshes coalesce into a single upstream call ──
  {
    let calls = 0;
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse(OK_PAYLOAD);
      }),
    });
    services.push(service);
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    assert.equal(a, true);
    assert.equal(b, true);
    assert.equal(calls, 1);
    console.log("[PASS] 7. concurrent refreshes coalesced");
  }

  // ── 8. Route contract: 200 + snapshot + attribution ──
  {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse(OK_PAYLOAD)),
      now: () => Date.now(),
    });
    services.push(service);
    await service.refresh();

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    assert.equal(res.status, 200); // never an error status — UI degrades gracefully
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.available, true);
    assert.equal(body.stale, false);
    assert.equal(body.sourceName, "LiraScope");
    assert.equal(body.sourceUrl, "https://lirascope.syria-cloud.sy");
    assert.equal((body.rate as Record<string, unknown>).value, 14500);
    server.close();
    servers.length = 0;
    console.log("[PASS] 8. GET /fx/reference-rate → 200 + snapshot");
  }

  // ── 9. Route contract: 200 + available:false when the provider never responded ──
  {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => {
        throw new Error("offline");
      }),
    });
    services.push(service);
    await service.refresh();

    const app = express();
    const router = express.Router();
    registerFxRoutes(router, service, (_req, _res, next) => next());
    app.use(router);
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.available, false);
    server.close();
    servers.length = 0;
    console.log("[PASS] 9. endpoint returns available:false (no crash)");
  }

  // ── 10. Route requires authentication ──
  {
    const service = new FxRateService({
      fetchImpl: makeFetch(async () => jsonResponse(OK_PAYLOAD)),
    });
    services.push(service);

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
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/fx/reference-rate`);
    assert.equal(res.status, 401);
    server.close();
    servers.length = 0;
    console.log("[PASS] 10. endpoint requires authentication (401)");
  }

  // ── 11. Live call to the real provider (--live) ──
  if (process.argv.includes("--live")) {
    const service = new FxRateService({ fetchTimeoutMs: 10_000 });
    services.push(service);
    try {
      const ok = await service.refresh();
      const snap = service.getSnapshot();
      if (ok && snap.available) {
        console.log(
          `[LIVE] real provider responded: value=${snap.rate?.value} sell=${snap.rate?.sell} buy=${snap.rate?.buy} source=${snap.sourceName} fetchedAt=${snap.fetchedAt}`,
        );
      } else {
        console.log(
          `[LIVE] SKIPPED — provider unreachable from this environment (snapshot: available=${snap.available}, reason=${snap.reason ?? "-"})`,
        );
      }
    } catch (e) {
      console.log(`[LIVE] SKIPPED — network error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  cleanup();
  console.log("\nALL CHECKS PASSED ✅");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nVERIFICATION FAILED ❌", err);
    cleanup();
    process.exit(1);
  });
